import type { ToolDetailDto, ToolStepDto } from "@ganglion/xacpx-relay-protocol";

export type ToolStepIndex = ReadonlyMap<string, ToolStepDto>;

/**
 * The subagent's streamed/finished output rides on the step detail (`text.output` and
 * the analogous fields on other shapes). Other detail shapes degrade gracefully so
 * pre-spec connectors still show something.
 */
export function subagentDetailOutput(d: ToolDetailDto | undefined): string {
  if (!d) return "";
  return d.type === "text" ? d.output ?? ""
    : d.type === "command" ? d.output ?? ""
    : d.type === "search" ? d.output ?? ""
    : d.type === "read" ? d.preview ?? ""
    : d.type === "fields" ? d.output ?? ""
    : "";
}

export function indexToolSteps(steps: readonly ToolStepDto[]): ToolStepIndex {
  return new Map(steps.map((step) => [step.toolCallId, step]));
}

export function hasToolStepAncestor(
  step: ToolStepDto,
  stepsById: ToolStepIndex,
  matches: (toolCallId: string) => boolean,
): boolean {
  for (const toolCallId of toolStepAncestorIds(step, stepsById)) {
    if (matches(toolCallId)) return true;
  }
  return false;
}

export function toolStepDepthWithin(step: ToolStepDto, rootToolCallId: string, stepsById: ToolStepIndex): number {
  let depth = 0;
  for (const toolCallId of toolStepAncestorIds(step, stepsById)) {
    if (toolCallId === rootToolCallId) return depth;
    depth += 1;
  }
  return depth;
}

function* toolStepAncestorIds(step: ToolStepDto, stepsById: ToolStepIndex): Generator<string> {
  let parentToolCallId = step.parentToolCallId;
  const seen = new Set<string>();
  while (parentToolCallId && !seen.has(parentToolCallId)) {
    yield parentToolCallId;
    seen.add(parentToolCallId);
    parentToolCallId = stepsById.get(parentToolCallId)?.parentToolCallId;
  }
}
