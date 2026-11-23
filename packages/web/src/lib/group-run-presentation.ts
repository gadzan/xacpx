import type {
  ConversationRunTraceEventDto,
  PlanEntryDto,
  ToolStepDto,
  TurnPartDto,
} from "@ganglion/xacpx-relay-protocol";

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
