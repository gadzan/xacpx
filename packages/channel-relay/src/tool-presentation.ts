import type { ToolUseEvent } from "xacpx/plugin-api";
import type { ToolStepDto, ToolDetailDto } from "@ganglion/xacpx-relay-protocol";

const TEXT_CAP = 8000;
const DIFF_CAP = 4000;

function cap(s: string, n = TEXT_CAP): string {
  return s.length > n ? s.slice(0, n) + "\n…(truncated)" : s;
}
function asString(v: unknown): string | undefined {
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return undefined;
}
function rec(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}
function blocksOf(content: unknown): Record<string, unknown>[] {
  if (Array.isArray(content)) return content.filter((b) => b && typeof b === "object") as Record<string, unknown>[];
  if (content && typeof content === "object") return [content as Record<string, unknown>];
  return [];
}
/** Extract display text from a single ACP ContentBlock (text/resource/resource_link). */
function textFromContentBlock(cb: Record<string, unknown>): string | undefined {
  switch (cb.type) {
    case "text":
      return asString(cb.text);
    case "resource_link":
      return asString(cb.title) ?? asString(cb.name) ?? asString(cb.uri);
    case "resource": {
      const r = rec(cb.resource);
      const text = asString(r.text);
      if (text) return text;
      const uri = asString(r.uri);
      return uri ? `[resource] ${uri}` : undefined;
    }
    default:
      return undefined; // image/audio/unknown — nothing useful to show as text
  }
}
function textFromBlocks(blocks: Record<string, unknown>[]): string | undefined {
  const parts: string[] = [];
  for (const b of blocks) {
    // ToolCallContent wraps a ContentBlock as { type:"content", content: ContentBlock };
    // some producers pass a bare ContentBlock (type text/resource/resource_link) directly.
    const t = b.type === "content" ? textFromContentBlock(rec(b.content)) : textFromContentBlock(b);
    if (t) parts.push(t);
  }
  return parts.length ? parts.join("\n") : undefined;
}
function diffBlock(blocks: Record<string, unknown>[]): Record<string, unknown> | undefined {
  return blocks.find((b) => b.type === "diff");
}
function parsedCmd0(input: Record<string, unknown>): Record<string, unknown> | undefined {
  const pc = input.parsed_cmd;
  if (Array.isArray(pc) && pc[0] && typeof pc[0] === "object") return pc[0] as Record<string, unknown>;
  return undefined;
}
function locationPath(event: ToolUseEvent): string | undefined {
  const locs = event.locations;
  if (Array.isArray(locs) && locs[0] && typeof locs[0] === "object") {
    const l = locs[0] as Record<string, unknown>;
    return asString(l.path) ?? asString(l.file);
  }
  return undefined;
}
function readLines(input: Record<string, unknown>): string | undefined {
  const { offset, limit } = input;
  if (typeof offset === "number" && typeof limit === "number") return `${offset}–${offset + limit}`;
  if (typeof limit === "number") return `first ${limit}`;
  return undefined;
}
function primitiveFields(input: Record<string, unknown>): Array<{ label: string; value: string }> {
  const out: Array<{ label: string; value: string }> = [];
  for (const [label, v] of Object.entries(input)) {
    const value = asString(v);
    if (value !== undefined) out.push({ label, value: cap(value) });
  }
  return out;
}

/** Normalize a raw core ToolUseEvent into a friendly, capped, presentation-ready step. */
export function toolUseEventToStepDto(event: ToolUseEvent): ToolStepDto {
  const input = rec(event.rawInput);
  const blocks = blocksOf(event.content);
  const output = rec(event.rawOutput);
  // acpx may emit a scalar (bare string/number) rawOutput; rec() yields {} for those,
  // so keep the scalar form as a last-resort text fallback below.
  const rawOutputText = asString(event.rawOutput);
  // Codex routes execute/search/read all through a terminal: the tool_call content is
  // [{type:"terminal",…}] (no inline text) and the result lands in
  // rawOutput.formatted_output (with exit status in rawOutput.exit_code) rather than
  // stdout/text or a content block. Treat formatted_output as a first-class output text.
  const terminalOut = asString(output.formatted_output);
  const pc = parsedCmd0(input);
  const fallbackTitle = event.summary ?? event.toolName;
  // On failure, surface the agent/tool error message so the web can show it in red.
  // Agents put it in different places: rawOutput.error (opencode), a content text
  // block, or the generic output field.
  const errMsg =
    event.status === "error"
      ? asString(output.error) ?? asString(output.message) ?? textFromBlocks(blocks) ?? asString(output.output) ?? asString(output.text) ?? terminalOut ?? rawOutputText
      : undefined;
  const base: Omit<ToolStepDto, "title" | "detail"> = {
    toolCallId: event.toolCallId,
    ...(event.parentToolCallId ? { parentToolCallId: event.parentToolCallId } : {}),
    ...(event.isSubagent ? { isSubagent: true } : {}),
    toolName: event.toolName,
    kind: event.kind,
    status: event.status,
    ...(event.durationMs !== undefined ? { durationMs: event.durationMs } : {}),
    ...(errMsg ? { error: cap(errMsg, 2000) } : {}),
  };

  // Delegated subagent (Agent/Task) steps: many adapters (qoder/kimi/codex) never emit
  // child tool events with parent links, so the web card has no timeline to show. Carry
  // the delegated prompt as `text` and the subagent's streamed/finished output as `output`
  // so the card can show live progress and render a result report — independent of `kind`.
  if (event.isSubagent) {
    const prompt =
      asString(input.prompt) ?? asString(input.description) ?? asString(input.task) ?? asString(input.instructions) ?? event.summary ?? "";
    const out = textFromBlocks(blocks) ?? asString(output.stdout) ?? terminalOut ?? asString(output.text) ?? rawOutputText;
    const detail: ToolDetailDto = { type: "text", text: cap(prompt), ...(out ? { output: cap(out) } : {}) };
    return { ...base, title: fallbackTitle, detail };
  }

  if (event.kind === "edit") {
    const diff = diffBlock(blocks);
    if (diff) {
      const path = asString(diff.path) ?? locationPath(event) ?? asString(input.file_path) ?? asString(input.path) ?? fallbackTitle;
      const detail: ToolDetailDto = { type: "diff", path, oldText: cap(asString(diff.oldText) ?? "", DIFF_CAP), newText: cap(asString(diff.newText) ?? "", DIFF_CAP) };
      return { ...base, title: path, detail };
    }
    const path = locationPath(event) ?? asString(input.file_path) ?? asString(input.path) ?? fallbackTitle;
    return { ...base, title: path, detail: { type: "fields", fields: primitiveFields(input) } };
  }

  if (event.kind === "read") {
    const path = asString(input.file_path) ?? asString(input.path) ?? asString(pc?.name) ?? locationPath(event) ?? fallbackTitle;
    const lines = readLines(input);
    const preview = textFromBlocks(blocks) ?? asString(output.stdout) ?? terminalOut ?? asString(output.text) ?? rawOutputText;
    const detail: ToolDetailDto = { type: "read", path, ...(lines ? { lines } : {}), ...(preview ? { preview: cap(preview) } : {}) };
    return { ...base, title: path, detail };
  }

  if (event.kind === "execute") {
    const command = asString(input.command) ?? asString(input.cmd) ?? asString(pc?.cmd) ?? fallbackTitle;
    const out = asString(output.stdout) ?? terminalOut ?? textFromBlocks(blocks) ?? asString(output.text) ?? rawOutputText;
    const exitCode = typeof output.exitCode === "number" ? output.exitCode : typeof output.exit_code === "number" ? output.exit_code : undefined;
    const detail: ToolDetailDto = { type: "command", command, ...(out ? { output: cap(out) } : {}), ...(exitCode !== undefined ? { exitCode } : {}) };
    return { ...base, title: command, detail };
  }

  if (event.kind === "search") {
    const query = asString(input.query) ?? asString(input.pattern) ?? asString(input.search) ?? asString(input.command) ?? asString(pc?.cmd) ?? fallbackTitle;
    const out = textFromBlocks(blocks) ?? asString(output.stdout) ?? terminalOut ?? asString(output.text) ?? rawOutputText;
    const detail: ToolDetailDto = { type: "search", query, ...(out ? { output: cap(out) } : {}) };
    return { ...base, title: query, detail };
  }

  if (event.kind === "think") {
    const text = asString(input.description) ?? asString(input.prompt) ?? textFromBlocks(blocks) ?? "";
    return { ...base, title: fallbackTitle, detail: { type: "text", text: cap(text) } };
  }

  const out = textFromBlocks(blocks) ?? asString(output.stdout) ?? terminalOut ?? asString(output.text) ?? rawOutputText;
  return { ...base, title: fallbackTitle, detail: { type: "fields", fields: primitiveFields(input), ...(out ? { output: cap(out) } : {}) } };
}
