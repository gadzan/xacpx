import type { PeerMessageHistoryEntry, ToolStepDto, TurnPartDto } from "@ganglion/xacpx-relay-protocol";
import { markdownBlockBoundaries } from "./render-markdown";
import { hasToolStepAncestor, indexToolSteps } from "./subagent-trace";

export type TurnPresentationItem =
  | { key: string; type: "text"; text: string; isLatest: boolean }
  | { key: string; type: "reasoning"; text: string; isLatest: boolean }
  | { key: string; type: "tool"; step: ToolStepDto; isLatest: boolean }
  | {
      key: string;
      type: "subagent";
      step: ToolStepDto;
      children: ToolStepDto[];
      isLatest: boolean;
    }
  | {
      key: string;
      type: "agent-message";
      message: PeerMessageHistoryEntry;
      anchorToolCallId: string;
      isLatest: boolean;
    };

/** Optional composition inputs. `sentAgentMessageById` keys SENT peer-message
 *  history entries by messageId so the sent card can be joined — presentation-only —
 *  to the exact agent_send tool step whose structured receipt carries that id.
 *  The persisted rows stay the canonical record; nothing here mutates them. */
export interface TurnPresentationOptions {
  sentAgentMessageById?: Map<string, PeerMessageHistoryEntry>;
}

type ActivityPart =
  | Exclude<TurnPartDto, { type: "text" }>
  | { type: "subagent"; step: ToolStepDto; children: ToolStepDto[] };

/** MessageIds these parts can anchor a sent card to: every tool step's
 *  `agentMessageId`, including steps folded into subagent activities. Mirrors the
 *  anchoring deriveTurnPresentation performs, so a caller can suppress a standalone
 *  card row exactly when the card renders inside a turn. */
export function anchoredAgentMessageIds(parts: TurnPartDto[]): Set<string> {
  const ids = new Set<string>();
  for (const part of parts) {
    if (part.type === "tool" && part.step.agentMessageId) ids.add(part.step.agentMessageId);
  }
  return ids;
}

export function deriveTurnPresentation(
  parts: TurnPartDto[],
  opts?: TurnPresentationOptions,
): TurnPresentationItem[] {
  const latestVisibleIndex = parts.findLastIndex((part) =>
    part.type === "tool" || part.text.trim().length > 0,
  );
  const toolSteps = parts
    .filter((part): part is Extract<TurnPartDto, { type: "tool" }> => part.type === "tool")
    .map((part) => part.step);
  const stepsById = indexToolSteps(toolSteps);
  const subagentIds = new Set(
    toolSteps.filter((step) => step.isSubagent === true).map((step) => step.toolCallId),
  );
  const descendantsOf = (parentToolCallId: string) =>
    toolSteps.filter((step) =>
      hasToolStepAncestor(step, stepsById, (ancestorId) => ancestorId === parentToolCallId),
    );
  let narrative = "";
  const activities: Array<{
    offset: number;
    index: number;
    part: ActivityPart;
  }> = [];

  parts.forEach((part, index) => {
    if (part.type === "text") {
      narrative += part.text;
      return;
    }
    if (part.type === "reasoning" && !part.text.trim()) return;
    if (
      part.type === "tool"
      && hasToolStepAncestor(part.step, stepsById, (ancestorId) => subagentIds.has(ancestorId))
    ) return;
    if (part.type === "tool" && part.step.isSubagent) {
      activities.push({
        offset: narrative.length,
        index,
        part: {
          type: "subagent",
          step: part.step,
          children: descendantsOf(part.step.toolCallId),
        },
      });
      return;
    }
    activities.push({ offset: narrative.length, index, part });
  });

  const boundaries = markdownBlockBoundaries(narrative);

  const anchored = new Map<number, typeof activities>();
  for (const activity of activities) {
    const anchor = narrative.slice(0, activity.offset).trim().length === 0
      ? 0
      : (boundaries.find((boundary) => boundary >= activity.offset) ?? narrative.length);
    const group = anchored.get(anchor) ?? [];
    group.push(activity);
    anchored.set(anchor, group);
  }

  const result: TurnPresentationItem[] = [];
  let cursor = 0;

  // Sent cards join right after the exact tool step that produced them (a send made
  // inside a subagent anchors after the whole subagent activity). Each messageId
  // anchors at most once; receiver-direction entries never join — those stay
  // standalone timeline rows.
  const anchoredMessageIds = new Set<string>();
  const pushAgentMessages = (steps: ToolStepDto[]): void => {
    const byId = opts?.sentAgentMessageById;
    if (!byId || byId.size === 0) return;
    for (const step of steps) {
      const id = step.agentMessageId;
      if (!id || anchoredMessageIds.has(id)) continue;
      const message = byId.get(id);
      if (!message || message.direction !== "sent") continue;
      anchoredMessageIds.add(id);
      result.push({
        key: `agent-message:${id}`,
        type: "agent-message",
        message,
        anchorToolCallId: step.toolCallId,
        isLatest: false,
      });
    }
  };

  const pushText = (end: number) => {
    const text = narrative.slice(cursor, end);
    if (text.trim()) {
      result.push({
        key: `text:${cursor}`,
        type: "text",
        text,
        isLatest: false,
      });
    }
    cursor = end;
  };

  for (const [anchor, group] of [...anchored.entries()].sort(([a], [b]) => a - b)) {
    pushText(anchor);
    for (const activity of group) {
      if (activity.part.type === "reasoning") {
        result.push({
          key: `reasoning:${activity.index}`,
          type: "reasoning",
          text: activity.part.text,
          isLatest: activity.index === latestVisibleIndex,
        });
      } else if (activity.part.type === "tool") {
        result.push({
          key: `tool:${activity.part.step.toolCallId}`,
          type: "tool",
          step: activity.part.step,
          isLatest: activity.index === latestVisibleIndex,
        });
        pushAgentMessages([activity.part.step]);
      } else {
        result.push({
          key: `subagent:${activity.part.step.toolCallId}`,
          type: "subagent",
          step: activity.part.step,
          children: activity.part.children,
          isLatest: activity.index === latestVisibleIndex,
        });
        pushAgentMessages([activity.part.step, ...activity.part.children]);
      }
    }
  }
  pushText(narrative.length);

  if (latestVisibleIndex >= 0 && parts[latestVisibleIndex]?.type === "text") {
    const latestText = result.findLast((item) => item.type === "text");
    if (latestText) latestText.isLatest = true;
  }

  return result;
}
