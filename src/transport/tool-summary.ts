/**
 * Shared tool input summarization and emptiness guards for CLI and Runtime
 * transport pipelines (normalization spec §9).
 */

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** True for values that carry no information and so must NOT clobber a prior value:
 *  undefined/null, blank strings, and empty objects/arrays. acpx's initial `tool_call`
 *  frame ships empty `content: []` / `rawInput: {}`, and a terminal frame omits fields
 *  entirely — neither should erase data a richer in-progress frame already supplied. */
export function isEmptyToolField(v: unknown): boolean {
  if (v === undefined || v === null) return true;
  if (typeof v === "string") return v.trim().length === 0;
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === "object") return Object.keys(v as object).length === 0;
  return false;
}

export function cursorToolInput(rawInput: unknown): Record<string, unknown> | undefined {
  if (!isRecord(rawInput)) return undefined;
  if (isRecord(rawInput.args)) return rawInput.args;
  return rawInput;
}

export function readFirstString(record: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}

export function readFirstStringArray(record: Record<string, unknown>, keys: readonly string[]): string[] | undefined {
  for (const key of keys) {
    const value = record[key];
    if (!Array.isArray(value)) continue;
    const entries = value
      .map((entry) => (typeof entry === "string" && entry.trim().length > 0 ? entry.trim() : undefined))
      .filter((entry): entry is string => entry !== undefined);
    if (entries.length > 0) {
      return entries;
    }
  }
  return undefined;
}

export function summarizeTaskInput(rawInput: Record<string, unknown>, title: string): string | undefined {
  const subagentType = readFirstString(rawInput, ["subagent_type", "subagentType", "agent", "agentType"]);
  const description = readFirstString(rawInput, ["description", "task", "summary"]);
  if (subagentType && description) {
    return description === title ? subagentType : `${subagentType}: ${description}`;
  }
  if (subagentType) return subagentType;
  return undefined;
}

export function summarizeToolInput(rawInput: unknown, title = ""): string | undefined {
  if (rawInput == null) return undefined;
  if (typeof rawInput === "string" || typeof rawInput === "number" || typeof rawInput === "boolean") {
    return String(rawInput);
  }
  if (!isRecord(rawInput)) return undefined;

  const nestedInput = cursorToolInput(rawInput);
  if (nestedInput !== rawInput) {
    const nestedSummary = summarizeToolInput(nestedInput, title);
    if (nestedSummary) return nestedSummary;
  }

  const taskSummary = summarizeTaskInput(rawInput, title);
  if (taskSummary) return taskSummary;

  const command = readFirstString(rawInput, ["command", "cmd", "program"]);
  const args = readFirstStringArray(rawInput, ["args", "arguments"]);
  if (command) {
    return [command, ...(args ?? [])].join(" ");
  }

  const parsedCmd = rawInput.parsed_cmd;
  if (Array.isArray(parsedCmd) && parsedCmd.length > 0) {
    const parts: string[] = [];
    for (const entry of parsedCmd) {
      if (isRecord(entry) && typeof entry.cmd === "string" && entry.cmd.length > 0) {
        parts.push(entry.cmd);
      }
    }
    if (parts.length > 0) {
      return parts.join(" ");
    }
  }

  const globPattern = readFirstString(rawInput, ["glob_pattern"]);
  if (globPattern) {
    const targetDirectory = readFirstString(rawInput, ["target_directory"]);
    return targetDirectory ? `${globPattern} in ${targetDirectory}` : globPattern;
  }

  const mode = readFirstString(rawInput, ["target_mode_id", "mode_id"]);
  const explanation = readFirstString(rawInput, ["explanation"]);
  if (mode || explanation) {
    return mode && explanation ? `${mode}: ${explanation}` : mode ?? explanation;
  }

  return readFirstString(rawInput, [
    "path",
    "file",
    "filePath",
    "filepath",
    "file_path",
    "target",
    "uri",
    "url",
    "query",
    "pattern",
    "text",
    "search",
    "working_directory",
    "name",
    "description",
  ]);
}

export const TOOL_OUTPUT_SUMMARY_MAX_CHARS = 500;

/** True when a frame's `content` is just the tool's own arguments echoed back as
 *  text — some drivers (Kimi) stream `rawInput` incrementally through
 *  `content[].content.text` (`{"path":"packages` → `{"path":"packages/…`), which
 *  the presentation layer would render as a growing wall of partial JSON.
 *
 *  Two independent signals, either of which is sufficient:
 *  1. the text is a prefix of (or equal to) the serialized `rawInput` already
 *     merged for this call — the complete echo case; or
 *  2. the text opens a JSON object but never closes it — an in-flight echo, which
 *     is how the driver reports arguments before `rawInput` itself arrives.
 *
 *  Blocks that are complete JSON but NOT an argument echo (real results, agent_send
 *  receipts) have a closing brace and unknown keys, so they are kept. Diff blocks
 *  and any non-text block are never echoes. */
export function isToolArgumentEchoContent(content: unknown, rawInput: unknown): boolean {
  if (!Array.isArray(content) || content.length === 0) return false;
  const serializedInput = isRecord(rawInput) ? JSON.stringify(rawInput) : undefined;
  let sawText = false;
  for (const entry of content) {
    const block = isRecord(entry) ? entry : undefined;
    if (!block) return false;
    if (block.type === "diff") return false;
    const inner = isRecord(block.content) ? block.content : block;
    if (inner.type !== "text") return false;
    sawText = true;
    const text = typeof inner.text === "string" ? inner.text.trim() : "";
    if (!text.startsWith("{")) return false;
    if (serializedInput !== undefined && serializedInput.startsWith(text)) continue;
    // An object that never closes is an in-flight argument echo: a tool RESULT is
    // always complete by the time it is reported.
    if (!text.includes("}")) continue;
    return false;
  }
  return sawText;
}

export function summarizeToolOutput(rawOutput: unknown): string | undefined {
  if (rawOutput == null) return undefined;
  if (typeof rawOutput === "string" || typeof rawOutput === "number" || typeof rawOutput === "boolean") {
    const text = String(rawOutput).trim();
    if (!text) return undefined;
    return text.length > TOOL_OUTPUT_SUMMARY_MAX_CHARS ? text.slice(0, TOOL_OUTPUT_SUMMARY_MAX_CHARS) : text;
  }
  if (!isRecord(rawOutput)) return undefined;

  const direct = readFirstString(rawOutput, ["text", "message", "error", "stdout", "stderr", "content"]);
  if (direct) {
    return direct.length > TOOL_OUTPUT_SUMMARY_MAX_CHARS ? direct.slice(0, TOOL_OUTPUT_SUMMARY_MAX_CHARS) : direct;
  }

  if (Array.isArray(rawOutput.content)) {
    const parts: string[] = [];
    for (const item of rawOutput.content) {
      if (typeof item === "string" && item.trim().length > 0) {
        parts.push(item.trim());
      } else if (isRecord(item)) {
        const itemText = readFirstString(item, ["text", "content"]);
        if (itemText) parts.push(itemText);
      }
    }
    if (parts.length > 0) {
      const text = parts.join("\n");
      return text.length > TOOL_OUTPUT_SUMMARY_MAX_CHARS ? text.slice(0, TOOL_OUTPUT_SUMMARY_MAX_CHARS) : text;
    }
  }

  return undefined;
}
