import type { MessageRecordDto } from "@ganglion/xacpx-relay-protocol";

/** Rows the slot/reorder helpers can inspect. Matches persisted history and live transcript. */
export type SlottableMessage = Pick<MessageRecordDto, "direction" | "createdAt" | "startedAt" | "structured">;

export function isReceivedAgentMessage(row: SlottableMessage): boolean {
  return row.structured?.agentMessage?.direction === "received";
}

/** Prefer the peer card's epoch ms; fall back to the row ISO timestamp. Invalid/missing → undefined. */
export function messageCreatedAtMs(row: SlottableMessage): number | undefined {
  const fromPeer = row.structured?.agentMessage?.createdAt;
  if (typeof fromPeer === "number" && Number.isFinite(fromPeer)) return fromPeer;
  if (typeof row.createdAt !== "string") return undefined;
  const t = Date.parse(row.createdAt);
  return Number.isFinite(t) ? t : undefined;
}

export function isAssistantOutRow(row: SlottableMessage): boolean {
  return row.direction === "out" && row.structured?.agentMessage === undefined;
}

/**
 * Index of the last message that existed at `startedAt` (inclusive). The live turn
 * renders after this index. `-1` means the slot is at the start of the list.
 *
 * Mid-turn received cards (created after the turn began) stop the scan so they
 * stay below the live bubble.
 */
export function slotAfterIndexFromStartedAt(messages: SlottableMessage[], startedAt: number): number {
  let idx = -1;
  for (let i = 0; i < messages.length; i++) {
    const t = messageCreatedAtMs(messages[i]!);
    if (t === undefined || t <= startedAt) idx = i;
    else break;
  }
  return idx;
}

/**
 * History apply: for each assistant `out` with `startedAt`, move inbound agent-message
 * cards that currently sit BEFORE that out and whose `createdAt` is after `startedAt`
 * to immediately after the out.
 *
 * Hub insertion order is card1, card2, out (finish time). Without this, reload restacks
 * both received cards above the finished turn. Rows without `startedAt` are not moved
 * (legacy). Only predecessor cards are considered so a later turn's trigger is not
 * pulled backward onto an earlier out.
 */
export function placeReceivedCardsAfterTurns<T extends SlottableMessage>(rows: T[]): T[] {
  const out = rows.slice();
  let i = 0;
  while (i < out.length) {
    const row = out[i]!;
    if (!isAssistantOutRow(row) || typeof row.startedAt !== "number" || !Number.isFinite(row.startedAt)) {
      i += 1;
      continue;
    }
    const startedAt = row.startedAt;
    const movers: T[] = [];
    for (let j = 0; j < i; j++) {
      const prev = out[j]!;
      if (!isReceivedAgentMessage(prev)) continue;
      const t = messageCreatedAtMs(prev);
      if (t !== undefined && t > startedAt) movers.push(prev);
    }
    if (movers.length === 0) {
      i += 1;
      continue;
    }
    for (const mover of movers) {
      const at = out.indexOf(mover);
      if (at >= 0 && at < i) {
        out.splice(at, 1);
        i -= 1;
      }
    }
    const insertAt = out.indexOf(row) + 1;
    out.splice(insertAt, 0, ...movers);
    i = insertAt + movers.length;
  }
  return out;
}
