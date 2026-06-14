import type { ToolStepDto, ToolStepKind, ToolStepStatus } from "@ganglion/xacpx-relay-protocol";

/** Shared icon tables + a pure step-summarizer for ToolCallPanel. Borrowed from
 *  HAPI's tool-group summary idea (`toolGroups.ts`): instead of an endless wall of
 *  rows, the panel header shows an at-a-glance count of steps by kind and status. */
export const KIND_ICON: Record<ToolStepKind, string> = {
  read: "📖",
  search: "🔍",
  execute: "💻",
  edit: "✏️",
  think: "🧠",
  other: "🔧",
};

export const STATUS_ICON: Record<ToolStepStatus, string> = {
  running: "⏳",
  success: "✅",
  error: "❌",
};

const KIND_ORDER: ToolStepKind[] = ["read", "search", "execute", "edit", "think", "other"];
const STATUS_ORDER: ToolStepStatus[] = ["running", "success", "error"];

/** Many-step panels collapse by default so a long tool run doesn't bury the reply. */
export const AUTO_COLLAPSE_THRESHOLD = 5;

export interface SummaryEntry {
  icon: string;
  count: number;
}

export interface StepSummary {
  kinds: SummaryEntry[];
  statuses: SummaryEntry[];
}

export function summarizeSteps(steps: ToolStepDto[]): StepSummary {
  const kindCounts = new Map<ToolStepKind, number>();
  const statusCounts = new Map<ToolStepStatus, number>();
  for (const s of steps) {
    kindCounts.set(s.kind, (kindCounts.get(s.kind) ?? 0) + 1);
    statusCounts.set(s.status, (statusCounts.get(s.status) ?? 0) + 1);
  }
  return {
    kinds: KIND_ORDER.filter((k) => kindCounts.has(k)).map((k) => ({ icon: KIND_ICON[k], count: kindCounts.get(k)! })),
    statuses: STATUS_ORDER.filter((s) => statusCounts.has(s)).map((s) => ({ icon: STATUS_ICON[s], count: statusCounts.get(s)! })),
  };
}
