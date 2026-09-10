import type { PeerMessageHistoryEntry, ToolStepDto, TurnPartDto } from "@ganglion/xacpx-relay-protocol";
import { markdownSourceToPlainText, renderMarkdown } from "./render-markdown";
import {
  planTurnLayout,
  type MarkdownLayoutNode,
  type TurnLayoutGeometryCache,
  type TurnLayoutPlan,
} from "./turn-layout";
import { buildTurnTimeline, type TimelineActivity } from "./turn-timeline";
import { indexToolSteps } from "./subagent-trace";

export type TurnPresentationMarkdownItem = MarkdownLayoutNode;

export type TurnPresentationItem =
  | TurnPresentationMarkdownItem
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

export interface TurnPresentationPlan {
  nodes: TurnPresentationItem[];
  finalReplyNodes: TurnPresentationMarkdownItem[];
  layout: TurnLayoutPlan;
  toolCount: number;
  thoughtCount: number;
}

export interface TurnPresentationOptions {
  sentAgentMessageById?: Map<string, PeerMessageHistoryEntry>;
  streaming?: boolean;
  layoutCache?: TurnLayoutGeometryCache;
}

type DecoratedActivity =
  | {
      id: string;
      wireIndex: number;
      sourceOffset: number;
      type: "reasoning";
      text: string;
    }
  | {
      id: string;
      wireIndex: number;
      sourceOffset: number;
      type: "tool";
      step: ToolStepDto;
    }
  | {
      id: string;
      wireIndex: number;
      sourceOffset: number;
      type: "subagent";
      step: ToolStepDto;
      children: ToolStepDto[];
    };

export function anchoredAgentMessageIds(parts: TurnPartDto[]): Set<string> {
  const ids = new Set<string>();
  for (const part of parts) {
    if (part.type === "tool" && part.step.agentMessageId) ids.add(part.step.agentMessageId);
  }
  return ids;
}

function decorateActivities(
  timelineActivities: readonly TimelineActivity[],
): DecoratedActivity[] {
  const toolSteps = timelineActivities
    .filter((activity): activity is TimelineActivity & {
      payload: Extract<TurnPartDto, { type: "tool" }>;
    } => activity.payload.type === "tool")
    .map((activity) => activity.payload.step);
  const stepsById = indexToolSteps(toolSteps);
  const subagentIds = new Set(
    toolSteps.filter((step) => step.isSubagent === true).map((step) => step.toolCallId),
  );
  const rootSubagentByStep = new Map<string, string | null>();
  const resolvingSubagents = new Set<string>();
  const rootSubagentOf = (step: ToolStepDto): string | null => {
    const cached = rootSubagentByStep.get(step.toolCallId);
    if (cached !== undefined) return cached;
    if (resolvingSubagents.has(step.toolCallId)) return null;
    resolvingSubagents.add(step.toolCallId);
    const parentId = step.parentToolCallId;
    const parent = parentId ? stepsById.get(parentId) : undefined;
    const parentRoot = parent ? rootSubagentOf(parent) : null;
    const rootSubagentId = parentRoot ?? (parentId && subagentIds.has(parentId) ? parentId : null);
    resolvingSubagents.delete(step.toolCallId);
    rootSubagentByStep.set(step.toolCallId, rootSubagentId);
    return rootSubagentId;
  };
  const descendantsByParent = new Map<string, ToolStepDto[]>();
  for (const step of toolSteps) {
    const rootSubagentId = rootSubagentOf(step);
    if (!rootSubagentId) continue;
    const descendants = descendantsByParent.get(rootSubagentId) ?? [];
    descendants.push(step);
    descendantsByParent.set(rootSubagentId, descendants);
  }

  const result: DecoratedActivity[] = [];
  for (const activity of timelineActivities) {
    if (activity.payload.type === "reasoning") {
      if (!activity.payload.text.trim()) continue;
      result.push({
        id: activity.id,
        wireIndex: activity.wireIndex,
        sourceOffset: activity.sourceOffset,
        type: "reasoning",
        text: activity.payload.text,
      });
      continue;
    }
    const step = activity.payload.step;
    if (rootSubagentOf(step)) {
      continue;
    }
    if (step.isSubagent) {
      result.push({
        id: activity.id,
        wireIndex: activity.wireIndex,
        sourceOffset: activity.sourceOffset,
        type: "subagent",
        step,
        children: descendantsByParent.get(step.toolCallId) ?? [],
      });
      continue;
    }
    result.push({
      id: activity.id,
      wireIndex: activity.wireIndex,
      sourceOffset: activity.sourceOffset,
      type: "tool",
      step,
    });
  }
  return result;
}

export function deriveTurnPresentation(
  parts: TurnPartDto[],
  options: TurnPresentationOptions = {},
): TurnPresentationPlan {
  const timeline = buildTurnTimeline(parts);
  const activities = decorateActivities(timeline.activities);
  const latestVisibleWireIndex = parts.findLastIndex((part) =>
    part.type === "tool" || part.text.trim().length > 0,
  );
  const latestVisibleIsText = latestVisibleWireIndex >= 0
    && parts[latestVisibleWireIndex]?.type === "text";
  if (activities.length === 0) {
    const html = timeline.narrative.trim()
      ? renderMarkdown(timeline.narrative, {
        streaming: options.streaming === true && latestVisibleIsText,
      })
      : "";
    const markdownNode: MarkdownLayoutNode | null = timeline.narrative.length > 0
      ? {
        type: "markdown",
        key: `markdown:0:${timeline.narrative.length}`,
        sourceRange: [0, timeline.narrative.length],
        source: timeline.narrative,
        html,
        copyText: html.trim()
          ? markdownSourceToPlainText(timeline.narrative, {
            streaming: options.streaming === true && latestVisibleIsText,
          }).trim()
          : "",
        isLatest: options.streaming === true && latestVisibleIsText,
      }
      : null;
    const layout: TurnLayoutPlan = {
      nodes: markdownNode ? [markdownNode] : [],
      activityPlacements: new Map(),
    };
    return {
      nodes: markdownNode && html.trim() ? [markdownNode] : [],
      finalReplyNodes: markdownNode && html.trim() ? [markdownNode] : [],
      layout,
      toolCount: 0,
      thoughtCount: 0,
    };
  }
  const layout = planTurnLayout(
    timeline.narrative,
    activities.map(({ id, wireIndex, sourceOffset }) => ({
      id,
      wireIndex,
      sourceOffset,
    })),
    {
      streaming: options.streaming === true,
      latestVisibleIsText,
    },
    options.layoutCache,
  );
  const activityById = new Map(activities.map((activity) => [activity.id, activity]));
  const nodes: TurnPresentationItem[] = [];
  const markdownByKey = new Map<string, TurnPresentationMarkdownItem>();
  const anchoredMessageIds = new Set<string>();

  const pushAgentMessages = (steps: readonly ToolStepDto[]): void => {
    const byId = options.sentAgentMessageById;
    if (!byId || byId.size === 0) return;
    for (const step of steps) {
      const id = step.agentMessageId;
      if (!id || anchoredMessageIds.has(id)) continue;
      const message = byId.get(id);
      if (!message || message.direction !== "sent") continue;
      anchoredMessageIds.add(id);
      nodes.push({
        key: `agent-message:${id}`,
        type: "agent-message",
        message,
        anchorToolCallId: step.toolCallId,
        isLatest: false,
      });
    }
  };

  for (const node of layout.nodes) {
    if (node.type === "markdown") {
      if (!node.html.trim()) continue;
      nodes.push(node);
      markdownByKey.set(node.key, node);
      continue;
    }
    const activity = activityById.get(node.activityId);
    if (!activity) throw new Error(`Missing presentation activity: ${node.activityId}`);
    const isLatest = activity.wireIndex === latestVisibleWireIndex;
    if (activity.type === "reasoning") {
      nodes.push({
        key: `reasoning:${activity.id}`,
        type: "reasoning",
        text: activity.text,
        isLatest,
      });
    } else if (activity.type === "tool") {
      nodes.push({
        key: `tool:${activity.step.toolCallId}`,
        type: "tool",
        step: activity.step,
        isLatest,
      });
      pushAgentMessages([activity.step]);
    } else {
      nodes.push({
        key: `subagent:${activity.step.toolCallId}`,
        type: "subagent",
        step: activity.step,
        children: activity.children,
        isLatest,
      });
      pushAgentMessages([activity.step, ...activity.children]);
    }
  }

  const lastLayoutActivityIndex = layout.nodes.findLastIndex((node) => node.type === "activity");
  const finalReplyNodes = layout.nodes
    .slice(lastLayoutActivityIndex + 1)
    .filter((node): node is MarkdownLayoutNode => node.type === "markdown" && node.html.trim().length > 0)
    .map((node) => markdownByKey.get(node.key) ?? node);

  return {
    nodes,
    finalReplyNodes,
    layout,
    toolCount: nodes.filter((node) => node.type === "tool" || node.type === "subagent").length,
    thoughtCount: nodes.filter((node) => node.type === "reasoning").length,
  };
}

export interface CollapsedTraceSummary {
  finalReplyText: string;
  toolCount: number;
  thoughtCount: number;
  presentation: TurnPresentationPlan;
}

export function extractCollapsedTraceSummary(
  parts: TurnPartDto[],
  options: TurnPresentationOptions = {},
): CollapsedTraceSummary {
  const presentation = deriveTurnPresentation(parts, options);
  return {
    finalReplyText: presentation.finalReplyNodes.map((node) => node.copyText).join(""),
    toolCount: presentation.toolCount,
    thoughtCount: presentation.thoughtCount,
    presentation,
  };
}
