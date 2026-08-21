import type { ToolUseEvent } from "xacpx/plugin-api";
import type { ToolStepDto, ToolDetailDto } from "@ganglion/xacpx-relay-protocol";

const TEXT_CAP = 8000;
const DIFF_CAP = 4000;
const INSTRUCTION_CAP = 300;

function cap(s: string, n = TEXT_CAP): string {
  return s.length > n ? s.slice(0, n) + "\n…(truncated)" : s;
}
/** Keep the tail instead of the head — for streams that append over time (subagent
 * output), so the newest content keeps changing after the cap is hit. */
function capTail(s: string, n = TEXT_CAP): string {
  return s.length > n ? "(truncated)…\n" + s.slice(s.length - n) : s;
}
function asString(v: unknown): string | undefined {
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return undefined;
}
function rec(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}
function toolInput(v: unknown): Record<string, unknown> {
  const input = rec(v);
  const nested = rec(input.args);
  return Object.keys(nested).length > 0 ? nested : input;
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
/** Adapter bookkeeping that names the tool rather than describing the call
 *  (cursor-agent stamps every rawInput with `_toolName`). Keep in sync with
 *  `CURSOR_TOOL_NAME_KEY` in `src/transport/streaming-prompt.ts` — channel-relay
 *  cannot import transport. The card already shows the tool name in its header. */
const INTERNAL_INPUT_KEYS = new Set(["_toolName"]);

function primitiveFields(input: Record<string, unknown>): Array<{ label: string; value: string }> {
  const out: Array<{ label: string; value: string }> = [];
  for (const [label, v] of Object.entries(input)) {
    if (INTERNAL_INPUT_KEYS.has(label)) continue;
    const value = asString(v);
    if (value !== undefined) out.push({ label, value: cap(value) });
  }
  return out;
}

/** Cursor reports search results as counts instead of matched text
 *  (`{totalMatches,truncated}` for grep, `{totalFiles,truncated}` for Find). */
function countSummary(output: Record<string, unknown>): string | undefined {
  const parts: string[] = [];
  if (typeof output.totalMatches === "number") parts.push(`${output.totalMatches} matches`);
  if (typeof output.totalFiles === "number") parts.push(`${output.totalFiles} files`);
  if (parts.length === 0) return undefined;
  if (output.truncated === true) parts.push("truncated");
  return parts.join(" · ");
}

/** messageId = "msg_" + randomUUID() (core agent-message-router); the loose
 * length bound keeps the gate tight without coupling to UUID formatting. */
const AGENT_MSG_ID_RE = /^msg_[0-9a-fA-F-]{8,}$/;
const AGENT_RECEIPT_STATUSES: Record<string, true> = { injected: true, queued: true, failed: true };

/** A record is a receipt only with a well-formed messageId AND a receipt status —
 * unrelated records that merely happen to carry a messageId field must not
 * correlate a step to the wrong (or any) peer message. */
function agentReceiptMessageId(v: unknown): string | undefined {
  const r = rec(v);
  const messageId = typeof r.messageId === "string" ? r.messageId : undefined;
  if (!messageId || !AGENT_MSG_ID_RE.test(messageId)) return undefined;
  return typeof r.status === "string" && AGENT_RECEIPT_STATUSES[r.status] === true ? messageId : undefined;
}

/** Extract the Agent Messaging receipt messageId from an agent_send tool event.
 * Structured shapes only: MCP structuredContent, a receipt-shaped rawOutput, a
 * JSON-RPC result envelope, or a single content text block that JSON-parses to
 * a receipt. The human display line ("Peer message msg_… accepted…") is never
 * parsed. Pure and total: malformed input yields undefined, never an exception. */
function extractAgentMessageId(event: ToolUseEvent): string | undefined {
  const output = rec(event.rawOutput);
  // Host preserved the MCP tool result's structured output.
  const direct = agentReceiptMessageId(output.structuredContent) ?? agentReceiptMessageId(output);
  if (direct) return direct;
  // Host wrapped the result in a JSON-RPC envelope: {result:{structuredContent:…}} or {result:<receipt>}.
  const result = rec(output.result);
  const enveloped = agentReceiptMessageId(result.structuredContent) ?? agentReceiptMessageId(result);
  if (enveloped) return enveloped;
  // Host stringified the MCP result into a single text block.
  const blocks = blocksOf(event.content);
  const block = blocks[0];
  if (block && block.type === "text" && typeof block.text === "string") {
    try {
      return agentReceiptMessageId(JSON.parse(block.text));
    } catch {
      // not JSON (e.g. the human display line) — nothing structured to read
    }
  }
  return undefined;
}

/** Normalize a raw core ToolUseEvent into a friendly, capped, presentation-ready step. */
export function toolUseEventToStepDto(event: ToolUseEvent): ToolStepDto {
  const input = toolInput(event.rawInput);
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
  // Agent Messaging correlation: only the agent_send tool (bare or MCP-qualified
  // as mcp__xacpx__agent_send — tight suffix match, no fuzzy contains) and only
  // a valid structured receipt may anchor a messageId to the step.
  const agentMessageId =
    event.toolName === "agent_send" || /__?agent_send$/.test(event.toolName)
      ? extractAgentMessageId(event)
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
    ...(agentMessageId ? { agentMessageId } : {}),
  };

  // Delegated subagent (Agent/Task) steps: many adapters (qoder/kimi/codex) never emit
  // child tool events with parent links, so the web card has no timeline to show. Carry
  // the delegated prompt as `text` and the subagent's streamed/finished output as `output`
  // so the card can show live progress and render a result report — independent of `kind`.
  if (event.isSubagent) {
    const prompt =
      asString(input.prompt) ?? asString(input.description) ?? asString(input.task) ?? asString(input.instructions) ?? event.summary ?? "";
    const out = textFromBlocks(blocks) ?? asString(output.stdout) ?? terminalOut ?? asString(output.text) ?? rawOutputText;
    // Tail-truncate: subagent output accumulates while streaming, so a head cap would
    // freeze the visible text (and the web card's heartbeat) once it passes TEXT_CAP.
    const detail: ToolDetailDto = { type: "text", text: cap(prompt), ...(out ? { output: capTail(out) } : {}) };
    return { ...base, title: fallbackTitle, detail };
  }

  if (event.kind === "edit") {
    const diff = diffBlock(blocks);
    const path =
      asString(diff?.path) ?? locationPath(event) ?? asString(input.file_path) ?? asString(input.path) ?? fallbackTitle;
    const oldText = asString(diff?.oldText) ?? asString(input.old_string) ?? asString(input.oldText);
    const newText = asString(diff?.newText) ?? asString(input.new_string) ?? asString(input.newText) ?? asString(input.content);
    const instruction = asString(input.instruction) ?? asString(input.description);
    if (diff || oldText !== undefined || newText !== undefined) {
      const detail: ToolDetailDto = {
        type: "diff",
        path,
        oldText: cap(oldText ?? "", DIFF_CAP),
        newText: cap(newText ?? "", DIFF_CAP),
        ...(instruction ? { instruction: cap(instruction, INSTRUCTION_CAP) } : {}),
      };
      return { ...base, title: path, detail };
    }
    const fields = primitiveFields(input);
    if (fields.length === 0) return { ...base, title: path };
    return { ...base, title: path, detail: { type: "fields", fields } };
  }

  if (event.kind === "read") {
    const path = asString(input.file_path) ?? asString(input.path) ?? asString(pc?.name) ?? locationPath(event) ?? fallbackTitle;
    const lines = readLines(input);
    // `output.content` is cursor-agent's file body — without it a Cursor read card
    // has no preview at all, since it sends neither content blocks nor stdout.
    const preview = textFromBlocks(blocks) ?? asString(output.stdout) ?? terminalOut ?? asString(output.text) ?? asString(output.content) ?? rawOutputText;
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
    const globPattern = asString(input.glob_pattern);
    const targetDirectory = asString(input.target_directory);
    const query = globPattern
      ? (targetDirectory ? `${globPattern} in ${targetDirectory}` : globPattern)
      : asString(input.query) ?? asString(input.pattern) ?? asString(input.search) ?? asString(input.command) ?? asString(pc?.cmd) ?? fallbackTitle;
    const out = textFromBlocks(blocks) ?? asString(output.stdout) ?? terminalOut ?? asString(output.text) ?? rawOutputText ?? countSummary(output);
    const detail: ToolDetailDto = { type: "search", query, ...(out ? { output: cap(out) } : {}) };
    return { ...base, title: query, detail };
  }

  if (event.kind === "think") {
    const mode = asString(input.target_mode_id) ?? asString(input.mode_id);
    const explanation = asString(input.explanation);
    const text = mode && explanation
      ? `${mode}: ${explanation}`
      : explanation ?? mode ?? asString(input.description) ?? asString(input.prompt) ?? textFromBlocks(blocks) ?? "";
    // A think step whose payload the adapter withheld (Cursor's todo tool announces
    // itself with no arguments) has nothing to expand into — omit the detail so the
    // card renders as a single header row instead of an empty drawer.
    if (!text) return { ...base, title: fallbackTitle };
    return { ...base, title: fallbackTitle, detail: { type: "text", text: cap(text) } };
  }

  const out = textFromBlocks(blocks) ?? asString(output.stdout) ?? terminalOut ?? asString(output.text) ?? rawOutputText;
  const fields = primitiveFields(input);
  if (fields.length === 0 && !out) return { ...base, title: fallbackTitle };
  return { ...base, title: fallbackTitle, detail: { type: "fields", fields, ...(out ? { output: cap(out) } : {}) } };
}
