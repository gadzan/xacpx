import { access, open, readFile, readdir, stat } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { ToolUseEvent, ToolUseKind } from "../channels/types.js";

const DEFAULT_POLL_INTERVAL_MS = 250;
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const ASYNC_AGENT_LAUNCH = /Async agent launched successfully|["']?status["']?\s*:\s*["']async_launched["']/i;

export interface ClaudeBackgroundFollowupOptions {
  cwd: string;
  sessionId: string;
  launchedToolCallIds: Iterable<string>;
  signal?: AbortSignal;
  homeDir?: string;
  transcriptPath?: string;
  pollIntervalMs?: number;
  timeoutMs?: number;
  onText?: (text: string) => void | Promise<void>;
  onThought?: (text: string) => void | Promise<void>;
  onToolEvent?: (event: ToolUseEvent) => void | Promise<void>;
}

export interface ClaudeBackgroundFollowupResult {
  status: "completed" | "timeout" | "unavailable";
  transcriptPath?: string;
  completedToolCallIds: string[];
}

interface ClaudeRecord {
  type?: string;
  isSidechain?: boolean;
  message?: {
    role?: string;
    stop_reason?: string | null;
    content?: unknown;
  };
}

/** Detect the successful tool result Claude Code returns when an Agent was
 * launched asynchronously. Kept at the transport boundary so callers do not
 * need to know Claude's private task ids or output-file layout. */
export function isClaudeAsyncAgentLaunch(event: ToolUseEvent): boolean {
  return ASYNC_AGENT_LAUNCH.test(textOfUnknown(event.rawOutput));
}

/** Find Claude Code's native JSONL transcript for an ACP session. Claude's
 * project-folder encoding is tried first; a shallow fallback scan handles any
 * future/path-platform encoding drift. */
export async function findClaudeTranscriptPath(input: {
  cwd: string;
  sessionId: string;
  homeDir?: string;
}): Promise<string | undefined> {
  const projectsDir = join(input.homeDir ?? homedir(), ".claude", "projects");
  const direct = join(projectsDir, encodeClaudeProjectDirectory(input.cwd), `${input.sessionId}.jsonl`);
  if (await exists(direct)) return direct;

  try {
    const entries = await readdir(projectsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const candidate = join(projectsDir, entry.name, `${input.sessionId}.jsonl`);
      if (await exists(candidate)) return candidate;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

/** Follow the out-of-band continuation Claude Code creates after an ACP prompt
 * launches async Agent tools and returns `end_turn`. Claude writes task
 * notifications and the resumed main-agent answer to its native JSONL even
 * though the ACP request is already closed. We replay only records after that
 * prompt's first end_turn and finish after every tracked task notified the main
 * agent and a subsequent main-agent end_turn was written. */
export async function followClaudeBackgroundTurn(
  options: ClaudeBackgroundFollowupOptions,
): Promise<ClaudeBackgroundFollowupResult> {
  const transcriptPath = options.transcriptPath ?? await findClaudeTranscriptPath(options);
  if (!transcriptPath) {
    return { status: "unavailable", completedToolCallIds: [] };
  }

  let initial: Buffer;
  try {
    initial = await readFile(transcriptPath);
  } catch {
    return { status: "unavailable", transcriptPath, completedToolCallIds: [] };
  }

  const initialCompleteEnd = initial.lastIndexOf(0x0a);
  const initialComplete = initial.subarray(0, initialCompleteEnd >= 0 ? initialCompleteEnd : 0).toString("utf8");
  let partial = initialCompleteEnd >= 0 ? initial.subarray(initialCompleteEnd + 1).toString("utf8") : initial.toString("utf8");
  let offset = initial.length;
  const initialRecords = initialComplete.split("\n").map(parseRecord);
  const launched = new Set([...options.launchedToolCallIds].filter(Boolean));
  const completed = new Set<string>();
  const toolEvents = new Map<string, ToolUseEvent>();
  const boundary = findPromptBoundary(initialRecords, launched);
  let sequence = 0;
  let lastNotificationSequence = -1;
  let done = false;

  const emitTool = async (event: ToolUseEvent): Promise<void> => {
    toolEvents.set(event.toolCallId, event);
    await options.onToolEvent?.(event);
  };

  const processRecord = async (record: ClaudeRecord | undefined): Promise<void> => {
    if (!record) return;
    sequence += 1;
    const blocks = contentBlocks(record.message?.content);

    if (record.type === "user") {
      const userText = blocks.map(blockText).filter(Boolean).join("\n");
      for (const id of taskNotificationToolIds(userText)) {
        if (launched.has(id)) {
          completed.add(id);
          lastNotificationSequence = sequence;
        }
      }
      for (const block of blocks) {
        if (readString(block, "type") !== "tool_result") continue;
        const toolCallId = readString(block, "tool_use_id");
        if (!toolCallId) continue;
        const output = blockText(block);
        if (ASYNC_AGENT_LAUNCH.test(output)) launched.add(toolCallId);
        const previous = toolEvents.get(toolCallId);
        await emitTool({
          toolCallId,
          toolName: previous?.toolName ?? "Tool",
          kind: previous?.kind ?? "other",
          ...(previous?.summary ? { summary: previous.summary } : {}),
          ...(previous?.rawInput !== undefined ? { rawInput: previous.rawInput } : {}),
          ...(output ? { rawOutput: output } : {}),
          status: readBoolean(block, "is_error") ? "error" : "success",
        });
      }
      return;
    }

    if (record.type !== "assistant" || record.isSidechain === true) return;
    for (const block of blocks) {
      const type = readString(block, "type");
      if (type === "text") {
        const text = readString(block, "text");
        if (text) await options.onText?.(text);
      } else if (type === "thinking") {
        const thought = readString(block, "thinking");
        if (thought) await options.onThought?.(thought);
      } else if (type === "tool_use") {
        const toolCallId = readString(block, "id");
        if (!toolCallId) continue;
        const name = readString(block, "name") ?? "Tool";
        const rawInput = (block as Record<string, unknown>).input;
        const event: ToolUseEvent = {
          toolCallId,
          toolName: name,
          kind: classifyToolKind(name),
          ...(toolSummary(rawInput) ? { summary: toolSummary(rawInput) } : {}),
          ...(rawInput !== undefined ? { rawInput } : {}),
          status: "running",
        };
        await emitTool(event);
      }
    }

    if (
      record.message?.stop_reason === "end_turn" &&
      launched.size > 0 &&
      [...launched].every((id) => completed.has(id)) &&
      lastNotificationSequence >= 0 &&
      sequence > lastNotificationSequence
    ) {
      done = true;
    }
  };

  // Closing the race between ACP result delivery and this watcher starting: if
  // Claude already appended a task notification/final answer, recover it now.
  if (boundary >= 0) {
    for (const record of initialRecords.slice(boundary + 1)) {
      await processRecord(record);
      if (done) break;
    }
  }

  const startedAt = Date.now();
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  while (!done) {
    throwIfAborted(options.signal);
    if (Date.now() - startedAt >= timeoutMs) {
      return {
        status: "timeout",
        transcriptPath,
        completedToolCallIds: [...completed],
      };
    }

    await waitForPoll(pollIntervalMs, options.signal);
    let size: number;
    try {
      size = (await stat(transcriptPath)).size;
    } catch {
      continue;
    }
    if (size <= offset) continue;

    let chunk: Buffer;
    try {
      const handle = await open(transcriptPath, "r");
      try {
        chunk = Buffer.alloc(size - offset);
        const result = await handle.read(chunk, 0, chunk.length, offset);
        chunk = chunk.subarray(0, result.bytesRead);
      } finally {
        await handle.close();
      }
    } catch {
      continue;
    }
    offset += chunk.length;
    partial += chunk.toString("utf8");
    const lines = partial.split("\n");
    partial = lines.pop() ?? "";
    for (const line of lines) {
      await processRecord(parseRecord(line));
      if (done) break;
    }
  }

  return {
    status: "completed",
    transcriptPath,
    completedToolCallIds: [...completed],
  };
}

function findPromptBoundary(records: Array<ClaudeRecord | undefined>, launched: Set<string>): number {
  let launchIndex = -1;
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (record?.type !== "assistant" || record.isSidechain === true) continue;
    for (const block of contentBlocks(record.message?.content)) {
      if (readString(block, "type") === "tool_use" && launched.has(readString(block, "id") ?? "")) {
        launchIndex = index;
      }
    }
  }
  if (launchIndex < 0) return -1;
  for (let index = launchIndex + 1; index < records.length; index += 1) {
    const record = records[index];
    if (record?.type === "assistant" && record.isSidechain !== true && record.message?.stop_reason === "end_turn") {
      return index;
    }
  }
  return -1;
}

function parseRecord(line: string): ClaudeRecord | undefined {
  if (!line.trim()) return undefined;
  try {
    return JSON.parse(line) as ClaudeRecord;
  } catch {
    return undefined;
  }
}

function contentBlocks(content: unknown): Array<Record<string, unknown>> {
  if (typeof content === "string") return [{ type: "text", text: content }];
  return Array.isArray(content)
    ? content.filter((block): block is Record<string, unknown> => !!block && typeof block === "object")
    : [];
}

function blockText(block: Record<string, unknown>): string {
  if (typeof block.text === "string") return block.text;
  if (typeof block.content === "string") return block.content;
  if (Array.isArray(block.content)) return block.content.map((item) => textOfUnknown(item)).filter(Boolean).join("\n");
  return textOfUnknown(block.content);
}

function textOfUnknown(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(textOfUnknown).filter(Boolean).join("\n");
  if (!value || typeof value !== "object") return "";
  const object = value as Record<string, unknown>;
  if (typeof object.text === "string") return object.text;
  if (object.content !== undefined) return textOfUnknown(object.content);
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}

function taskNotificationToolIds(text: string): string[] {
  const ids: string[] = [];
  const pattern = /<tool-use-id>([^<]+)<\/tool-use-id>/g;
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) ids.push(match[1]!.trim());
  return ids;
}

function classifyToolKind(name: string): ToolUseKind {
  const normalized = name.toLowerCase();
  if (/(read|view|open)/.test(normalized)) return "read";
  if (/(grep|search|find|glob)/.test(normalized)) return "search";
  if (/(edit|write|patch|replace|create)/.test(normalized)) return "edit";
  if (/(bash|shell|exec|run|terminal|command)/.test(normalized)) return "execute";
  if (/(think|reason|plan|agent|task)/.test(normalized)) return "think";
  return "other";
}

function toolSummary(input: unknown): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const object = input as Record<string, unknown>;
  for (const key of ["description", "summary", "path", "file_path", "query", "pattern", "command"] as const) {
    if (typeof object[key] === "string" && object[key].trim()) return object[key].trim();
  }
  return undefined;
}

function readString(object: unknown, key: string): string | undefined {
  if (!object || typeof object !== "object") return undefined;
  const value = (object as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}

function readBoolean(object: unknown, key: string): boolean {
  return !!object && typeof object === "object" && (object as Record<string, unknown>)[key] === true;
}

function encodeClaudeProjectDirectory(cwd: string): string {
  return cwd.replace(/[:\\/]/g, "-");
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.R_OK);
    return true;
  } catch {
    return false;
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("Claude background follow-up aborted", "AbortError");
}

async function waitForPoll(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) {
    await new Promise<void>((resolve) => setTimeout(resolve, ms));
    return;
  }
  throwIfAborted(signal);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("Claude background follow-up aborted", "AbortError"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
