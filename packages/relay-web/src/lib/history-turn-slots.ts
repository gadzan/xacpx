import type { MessageRecordDto } from "@ganglion/xacpx-relay-protocol";

/** Rows the slot/reorder helpers can inspect. Matches persisted history and live transcript. */
export type SlottableMessage = Pick<MessageRecordDto, "id" | "direction" | "startedAt" | "slotAfterId" | "structured">;

export function isReceivedAgentMessage(row: SlottableMessage): boolean {
  return row.structured?.agentMessage?.direction === "received";
}

export function isAssistantOutRow(row: SlottableMessage): boolean {
  return row.direction === "out" && row.structured?.agentMessage === undefined;
}

function isSlotAfterId(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/**
 * Index of the last message whose Hub id is `<= slotAfterId` (the durable insert-order
 * anchor from `turn-started`). `-1` means the slot is at the start of the list.
 *
 * Live path uses transcript index at turn-start; this is for history/seed/snapshot
 * where rows carry Hub ids. Do not infer this from wall clocks.
 */
export function slotAfterIndexFromAnchor(messages: SlottableMessage[], slotAfterId: number): number {
  let idx = -1;
  for (let i = 0; i < messages.length; i++) {
    const id = messages[i]!.id;
    if (typeof id === "number" && id <= slotAfterId) idx = i;
  }
  return idx;
}

/**
 * History apply: for each assistant `out` with `slotAfterId`, move every transcript
 * row currently sitting BEFORE that out whose Hub `id` is greater than the anchor
 * (inserted after turn-start) to immediately after the out.
 *
 * Hub insertion order is trigger, mid-turn rows, then `out` (finish time). Without
 * this, reload restacks mid-turn received cards AND queued prompts above the finished
 * turn. Rows without `slotAfterId` are not moved (legacy). Relative order of movers
 * is preserved. Clocks (`createdAt` / `startedAt`) are never consulted.
 */
export function placeTurnsInSlots<T extends SlottableMessage>(rows: T[]): T[] {
  const out = rows.slice();
  let i = 0;
  while (i < out.length) {
    const row = out[i]!;
    if (!isAssistantOutRow(row) || !isSlotAfterId(row.slotAfterId)) {
      i += 1;
      continue;
    }
    const anchor = row.slotAfterId;
    const movers: T[] = [];
    for (let j = 0; j < i; j++) {
      const prev = out[j]!;
      if (typeof prev.id !== "number") continue;
      if (prev.id > anchor) movers.push(prev);
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
