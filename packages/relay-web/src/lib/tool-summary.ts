import type { Component } from "vue";
import { BookOpen, Search, SquareTerminal, Pencil, Brain, Trash2, FolderInput, Globe, Wrench, Loader2, Check, X } from "lucide-vue-next";
import type { ToolStepDto, ToolStepKind, ToolStepStatus } from "@ganglion/xacpx-relay-protocol";
import { diffLines } from "./line-diff";

/** Shared icon tables + a pure step-summarizer for ToolCallPanel. Borrowed from
 *  HAPI's tool-group summary idea (`toolGroups.ts`): instead of an endless wall of
 *  rows, the panel header shows an at-a-glance count of steps by kind and status.
 *  Icons are Lucide components (rendered via `<component :is>`), not emoji. */
export const KIND_ICON: Record<ToolStepKind, Component> = {
  read: BookOpen,
  search: Search,
  execute: SquareTerminal,
  edit: Pencil,
  think: Brain,
  delete: Trash2,
  move: FolderInput,
  fetch: Globe,
  other: Wrench,
};

export const STATUS_ICON: Record<ToolStepStatus, Component> = {
  running: Loader2,
  success: Check,
  error: X,
};

const KIND_ORDER: ToolStepKind[] = ["read", "search", "execute", "edit", "think", "delete", "move", "fetch", "other"];
const STATUS_ORDER: ToolStepStatus[] = ["running", "success", "error"];

/** Only long legacy groups need the first-use hint; every group starts collapsed. */
export const GROUP_COLLAPSE_FUE_THRESHOLD = 5;

export interface DiffStats {
  add: number;
  del: number;
}

/** Line add/del counts for a diff detail (e.g. +4, −1). Null when the count
 *  would be misleading: naive fallback on huge inputs (exact === false) or
 *  connector-capped inputs carrying a "…(truncated)" marker. */
/** Truncation markers the connector can emit: `cap` appends a suffix, `capTail`
 *  prepends a prefix (execute/read/search output is tail-capped so the newest
 *  content — a test's failure summary, an error stack — is what the user reads).
 *  Both must be recognised wherever a capped string is compared or measured. */
const TRUNCATION_MARKS = ["…(truncated)", "(truncated)…"];

/** Strip every truncation marker so a capped and an uncapped rendering of the same
 *  text can be compared for equality. Single home for the marker list: the
 *  connector emits both spellings (`cap` suffix, `capTail` prefix) and any consumer
 *  that compares capped strings must agree with `diffStatsOf` on what they are. */
export function stripTruncationMarks(value: string): string {
  let out = value;
  for (const mark of TRUNCATION_MARKS) out = out.split(mark).join("");
  return out.trim();
}

/** True when a step title is a bare file path (`src/a.ts`, `C:\work\f.ts`).
 *  Path previews ellipsis at the head (…tail) so the filename — the part the
 *  user scans for — stays visible; commands, queries, and prose keep the
 *  default tail ellipsis. Only read/edit/delete titles are connector-derived
 *  paths. Structured match first: when the title equals the detail's own path,
 *  it is a path even with spaces (`/Users/me/My Project/a.ts`). The separator
 *  heuristic covers title-only steps; whitespace no longer disqualifies since
 *  real file paths allow spaces. */
export function isPathTitle(step: ToolStepDto): boolean {
  const { kind, title } = step;
  if (kind !== "read" && kind !== "edit" && kind !== "delete") return false;
  const d = step.detail;
  if (d && (d.type === "diff" || d.type === "read") && d.path === title) return true;
  return /[/\\]/.test(title);
}

export function diffStatsOf(detail: { type: string; oldText?: string; newText?: string } | undefined): DiffStats | null {
  if (!detail || detail.type !== "diff") return null;
  const { oldText = "", newText = "" } = detail;
  if (TRUNCATION_MARKS.some((mark) => oldText.includes(mark) || newText.includes(mark))) return null;
  const d = diffLines(oldText, newText);
  if (!d.exact) return null;
  if (d.add === 0 && d.del === 0) return null;
  return { add: d.add, del: d.del };
}

export interface SummaryEntry {
  icon: Component;
  count: number;
  /** The kind/status key (e.g. "read", "success") — used as a stable list key,
   *  a `data-test` suffix, and to drive per-status accent coloring. */
  label: string;
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
    kinds: KIND_ORDER.filter((k) => kindCounts.has(k)).map((k) => ({ icon: KIND_ICON[k], count: kindCounts.get(k)!, label: k })),
    statuses: STATUS_ORDER.filter((s) => statusCounts.has(s)).map((s) => ({ icon: STATUS_ICON[s], count: statusCounts.get(s)!, label: s })),
  };
}
