import type { MessageRecordDto, ToolDetailDto, ToolStepDto, TurnPartDto } from "@ganglion/xacpx-relay-protocol";

/** Short identifying snippet kept on compact tool cards (collapsed subagent line, path, command). */
export const COMPACT_DETAIL_PREVIEW = 240;

type StructuredTurn = NonNullable<MessageRecordDto["structured"]>;

function lastNonemptyLine(text: string, max: number): string {
  const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
  const last = lines.length ? lines[lines.length - 1]! : text.trim();
  return last.length > max ? `${last.slice(0, max)}…` : last;
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function detailPrompt(detail: ToolDetailDto): string {
  return detail.type === "text" ? detail.text
    : detail.type === "command" ? detail.command
    : detail.type === "search" ? detail.query
    : detail.type === "read" ? detail.path
    : detail.type === "fields" ? (detail.fields.map((f) => f.value).find((v) => v.trim()) ?? "")
    : detail.path;
}

function detailOutput(detail: ToolDetailDto): string {
  return detail.type === "text" ? detail.output ?? ""
    : detail.type === "command" ? detail.output ?? ""
    : detail.type === "search" ? detail.output ?? ""
    : detail.type === "read" ? detail.preview ?? ""
    : detail.type === "fields" ? detail.output ?? ""
    : "";
}

function isHeavyDetail(detail: ToolDetailDto | undefined): boolean {
  if (!detail) return false;
  switch (detail.type) {
    case "diff":
      return detail.oldText.length > 0 || detail.newText.length > 0;
    case "command":
    case "search":
      return (detail.output?.length ?? 0) > 0;
    case "read":
      return (detail.preview?.length ?? 0) > 0;
    case "text":
      return detail.text.length > COMPACT_DETAIL_PREVIEW || (detail.output?.length ?? 0) > COMPACT_DETAIL_PREVIEW;
    case "fields":
      return detail.fields.some((f) => f.value.length > 80) || (detail.output?.length ?? 0) > 0;
  }
}

function compactDetail(detail: ToolDetailDto, isSubagent: boolean): ToolDetailDto {
  if (isSubagent) {
    const prompt = clip(detailPrompt(detail), COMPACT_DETAIL_PREVIEW);
    const output = lastNonemptyLine(detailOutput(detail), COMPACT_DETAIL_PREVIEW);
    return { type: "text", text: prompt, ...(output ? { output } : {}) };
  }
  switch (detail.type) {
    case "diff":
      return {
        type: "diff",
        path: detail.path,
        oldText: "",
        newText: "",
        ...(detail.instruction ? { instruction: detail.instruction } : {}),
      };
    case "command":
      return {
        type: "command",
        command: detail.command,
        ...(detail.exitCode !== undefined ? { exitCode: detail.exitCode } : {}),
      };
    case "read":
      return { type: "read", path: detail.path, ...(detail.lines ? { lines: detail.lines } : {}) };
    case "search":
      return { type: "search", query: detail.query };
    case "text":
      return { type: "text", text: clip(detail.text, COMPACT_DETAIL_PREVIEW) };
    case "fields":
      return {
        type: "fields",
        fields: detail.fields.map((f) => ({ label: f.label, value: clip(f.value, 80) })),
      };
  }
}

function compactStep(step: ToolStepDto): ToolStepDto {
  if (!step.detail) return step;
  const { detail, ...rest } = step;
  return { ...rest, detail: compactDetail(detail, step.isSubagent === true) };
}

function compactPart(part: TurnPartDto): TurnPartDto {
  return part.type === "tool" ? { type: "tool", step: compactStep(part.step) } : part;
}

function stepIsHeavy(step: ToolStepDto): boolean {
  return isHeavyDetail(step.detail);
}

function structuredIsHeavy(structured: StructuredTurn): boolean {
  if (structured.parts?.some((p) => p.type === "tool" && stepIsHeavy(p.step))) return true;
  if (structured.toolSteps?.some(stepIsHeavy)) return true;
  return false;
}

/**
 * Project a history row for the transcript list: drop duplicate `toolSteps` when
 * `parts` already carries them, and strip bulky tool bodies (diffs, command output,
 * file previews). Collapsed cards keep titles/status plus a short subagent snippet.
 * The full row is available from `GET .../messages/:id`.
 * Top-level fields such as `startedAt`, `slotAfterId`, and `startedAfterSeq` are
 * copied through unchanged — compact must not drop the durable slot anchor.
 */
export function compactHistoryMessage(row: MessageRecordDto): MessageRecordDto {
  const structured = row.structured;
  if (!structured) return row;
  const hasParts = (structured.parts?.length ?? 0) > 0;
  const dropDuplicateSteps = hasParts && (structured.toolSteps?.length ?? 0) > 0;
  const heavy = structuredIsHeavy(structured);
  if (!dropDuplicateSteps && !heavy) return row;

  const next: StructuredTurn = { ...structured, ...(heavy ? { compact: true } : {}) };
  if (hasParts) {
    delete next.toolSteps;
    if (heavy && structured.parts) next.parts = structured.parts.map(compactPart);
  } else if (heavy && structured.toolSteps) {
    next.toolSteps = structured.toolSteps.map(compactStep);
  }
  return { ...row, structured: next };
}
