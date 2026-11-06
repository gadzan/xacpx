import type { MemberTurnSummaryDto, TurnPartDto } from "@ganglion/xacpx-relay-protocol";

export interface GroupLiveStreamRow {
  /** Stable while the member runs: text updates in place. */
  key: string;
  memberTurn: MemberTurnSummaryDto;
  /** Newest non-empty text part; empty on a placeholder (dots-only) row. */
  text: string;
  /** Part index of the displayed text, or -1 on a placeholder. */
  index: number;
  /** One live row per member: always the member's newest bubble. */
  latest: boolean;
  /** True on a row that only carries the dots (member has produced no text). */
  placeholder: boolean;
  /** True when this member's turn has not ended: the row may carry dots. */
  running: boolean;
}

export interface GroupLiveStreamInput {
  members: MemberTurnSummaryDto[];
  liveParts: (memberTurnId: string) => TurnPartDto[] | undefined;
  isRunning: (turn: MemberTurnSummaryDto) => boolean;
}

/** One row per live member, showing only the newest text part. Earlier text
 *  segments belong to the trace; keeping them in the Group narration made the
 *  conversation unreadable. Membership order is stable, so a new segment
 *  updates its own row instead of appending another one. */
export function interleaveGroupLiveStream(input: GroupLiveStreamInput): GroupLiveStreamRow[] {
  return input.members.map((turn) => {
    const parts = input.liveParts(turn.id) ?? [];
    let index = -1;
    let text = "";
    for (let partIndex = parts.length - 1; partIndex >= 0; partIndex -= 1) {
      const part = parts[partIndex];
      if (part?.type === "text" && part.text.trim().length > 0) {
        index = partIndex;
        text = part.text;
        break;
      }
    }
    return {
      key: `${turn.id}:live`,
      memberTurn: turn,
      text,
      index,
      latest: true,
      placeholder: index < 0,
      running: input.isRunning(turn),
    };
  });
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
