import type { MemberTurnSummaryDto, TurnPartDto } from "@ganglion/xacpx-relay-protocol";

export interface GroupLiveStreamRow {
  /** Stable across re-renders of the same segment: member + part index. */
  key: string;
  memberTurn: MemberTurnSummaryDto;
  /** Segment text; empty on a placeholder (dots-only) row. */
  text: string;
  /** True on the member's last segment while it runs: its dots sit under it. */
  latest: boolean;
  /** True on a row that only carries the dots (member has produced no text). */
  placeholder: boolean;
  /** True when this member's turn has not ended: the row may carry dots. */
  running: boolean;
}

export interface GroupLiveStreamInput {
  members: MemberTurnSummaryDto[];
  liveParts: (memberTurnId: string) => TurnPartDto[] | undefined;
  segmentOrder: readonly { memberTurnId: string; index: number; order: number }[];
  isRunning: (turn: MemberTurnSummaryDto) => boolean;
}

/** Arrival order comes from frame ingestion, not part indexes: two members'
 *  parts arrays are each internally ordered and say nothing about each other. */
export function interleaveGroupLiveStream(input: GroupLiveStreamInput): GroupLiveStreamRow[] {
  const ordered: { memberTurn: MemberTurnSummaryDto; index: number; order: number }[] = [];
  let fallbackOrder = input.segmentOrder.reduce((max, entry) => Math.max(max, entry.order), 0);

  for (const turn of input.members) {
    const parts = input.liveParts(turn.id) ?? [];
    const textIndexes = parts.flatMap((part, index) => (part.type === "text" ? [index] : []));
    if (textIndexes.length === 0) continue;
    const known = input.segmentOrder.filter((entry) => entry.memberTurnId === turn.id);
    const knownIndexes = new Set(known.map((entry) => entry.index));
    for (const entry of known) {
      if (!textIndexes.includes(entry.index)) continue;
      ordered.push({ memberTurn: turn, index: entry.index, order: entry.order });
    }
    // A reconnected snapshot has no cross-member order: keep its segments in part order.
    for (const index of textIndexes) {
      if (knownIndexes.has(index)) continue;
      ordered.push({ memberTurn: turn, index, order: ++fallbackOrder });
    }
  }

  ordered.sort((left, right) => left.order - right.order);
  const latestIndexByMember: Record<string, number> = {};
  for (const entry of ordered) latestIndexByMember[entry.memberTurn.id] = entry.index;

  const rows: GroupLiveStreamRow[] = [];
  for (const entry of ordered) {
    const parts = input.liveParts(entry.memberTurn.id) ?? [];
    const part = parts[entry.index];
    const text = part?.type === "text" ? part.text : "";
    if (text.length === 0) continue;
    rows.push({
      key: `${entry.memberTurn.id}:${entry.index}`,
      memberTurn: entry.memberTurn,
      text,
      latest: latestIndexByMember[entry.memberTurn.id] === entry.index,
      placeholder: false,
      running: input.isRunning(entry.memberTurn),
    });
  }

  for (const turn of input.members) {
    if (turn.id in latestIndexByMember) continue;
    rows.push({
      key: `${turn.id}:placeholder`,
      memberTurn: turn,
      text: "",
      latest: true,
      placeholder: true,
      running: input.isRunning(turn),
    });
  }

  return rows;
}

export interface SettledSegmentMessage {
  key: string;
  runId: string;
  memberTurnId: string;
  segments: string[];
}

export interface SettledSegmentRow {
  key: string;
  sourceKey: string;
  memberTurnId: string;
  text: string;
  index: number;
  /** Last segment of this member: carries the trace entry, time and copy. */
  last: boolean;
}

export interface SettledStream {
  rows: SettledSegmentRow[];
  anchorKey: string;
  memberKeys: string[];
}

/** Round-robin settled segments per Run. Rebuilt from durable messages, so a
 *  reload keeps the same order. */
export function buildSettledStreams(messages: readonly SettledSegmentMessage[]): Map<string, SettledStream> {
  const byRun = new Map<string, SettledSegmentMessage[]>();
  for (const message of messages) {
    const group = byRun.get(message.runId);
    if (group) group.push(message);
    else byRun.set(message.runId, [message]);
  }
  const streams = new Map<string, SettledStream>();
  for (const [runId, group] of byRun) {
    if (new Set(group.map((message) => message.memberTurnId)).size < 2) continue;
    const rows: SettledSegmentRow[] = [];
    const longest = Math.max(...group.map((message) => message.segments.length));
    for (let index = 0; index < longest; index += 1) {
      for (const message of group) {
        const text = message.segments[index];
        if (text === undefined) continue;
        rows.push({
          key: `${message.memberTurnId}:${index}`,
          sourceKey: message.key,
          memberTurnId: message.memberTurnId,
          text,
          index,
          last: index === message.segments.length - 1,
        });
      }
    }
    streams.set(runId, {
      rows,
      anchorKey: group[0]!.key,
      memberKeys: group.map((message) => message.key),
    });
  }
  return streams;
}
