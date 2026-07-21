import { access, open, readFile, readdir, stat } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

import type { ToolUseEvent, ToolUseKind } from "../channels/types.js";

const DEFAULT_POLL_INTERVAL_MS = 250;
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const FINAL_SUBAGENT_DRAIN_MAX_POLLS = 4;
const FINAL_SUBAGENT_DRAIN_STABLE_POLLS = 2;
const ASYNC_AGENT_LAUNCH = /Async agent launched successfully|["']?status["']?\s*:\s*["']async_launched["']/i;

export interface ClaudeBackgroundFollowupOptions {
  cwd: string;
  sessionId: string;
  launchedToolCallIds: Iterable<string>;
  /** Latest ACP events already observed before the native transcript follower starts. */
  initialToolEvents?: Iterable<ToolUseEvent>;
  /** Claude agent transcript id keyed by the Agent/Task tool call that launched it. */
  subagentIdsByToolCallId?: Iterable<readonly [string, string]>;
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
  failedToolCallIds: string[];
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

interface JsonlCursor {
  offset: number;
  partial: string;
}

/** Detect the successful tool result Claude Code returns when an Agent was
 * launched asynchronously. Kept at the transport boundary so callers do not
 * need to know Claude's private task ids or output-file layout. */
export function isClaudeAsyncAgentLaunch(event: ToolUseEvent): boolean {
  return ASYNC_AGENT_LAUNCH.test(textOfUnknown(event.rawOutput));
}

export function claudeAsyncAgentId(event: ToolUseEvent): string | undefined {
  const fromObject = findStringField(event.rawOutput, new Set(["agentId", "agent_id"]));
  if (fromObject) return fromObject;
  return /\bagent(?:Id|_id)["']?\s*[:=]\s*["']?([A-Za-z0-9_-]+)/i.exec(textOfUnknown(event.rawOutput))?.[1];
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
    return { status: "unavailable", completedToolCallIds: [], failedToolCallIds: [] };
  }

  let initial: Buffer;
  try {
    initial = await readFile(transcriptPath);
  } catch {
    return { status: "unavailable", transcriptPath, completedToolCallIds: [], failedToolCallIds: [] };
  }

  const initialCompleteEnd = initial.lastIndexOf(0x0a);
  const initialComplete = initial.subarray(0, initialCompleteEnd >= 0 ? initialCompleteEnd : 0).toString("utf8");
  const mainCursor: JsonlCursor = {
    offset: initial.length,
    partial: initialCompleteEnd >= 0 ? initial.subarray(initialCompleteEnd + 1).toString("utf8") : initial.toString("utf8"),
  };
  const initialRecords = initialComplete.split("\n").map(parseRecord);
  const launched = new Set([...options.launchedToolCallIds].filter(Boolean));
  const completed = new Set<string>();
  const failed = new Set<string>();
  const toolEvents = new Map<string, ToolUseEvent>();
  for (const event of options.initialToolEvents ?? []) toolEvents.set(event.toolCallId, event);
  const parentToolCallIdByAgentId = new Map<string, string>();
  for (const [toolCallId, agentId] of options.subagentIdsByToolCallId ?? []) {
    if (toolCallId && agentId) parentToolCallIdByAgentId.set(agentId, toolCallId);
  }
  const boundary = findPromptBoundary(initialRecords, launched);
  let launchSeen = boundary >= 0 || initialRecords.some((record) => hasTrackedLaunch(record, launched));
  let boundarySeen = boundary >= 0;
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
      for (const notification of taskNotifications(userText)) {
        if (launched.has(notification.toolCallId)) {
          completed.add(notification.toolCallId);
          if (notification.failed) failed.add(notification.toolCallId);
          lastNotificationSequence = sequence;
          const previous = toolEvents.get(notification.toolCallId);
          if (previous) {
            await emitTool({
              ...previous,
              status: notification.failed ? "error" : "success",
              ...(notification.failed ? { rawOutput: { message: "Claude background Agent failed" } } : {}),
            });
          }
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
          ...(previous?.parentToolCallId ? { parentToolCallId: previous.parentToolCallId } : {}),
          ...(previous?.isSubagent ? { isSubagent: true } : {}),
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

  const processAfterBoundary = async (record: ClaudeRecord | undefined): Promise<void> => {
    if (!record) return;
    if (!boundarySeen) {
      if (hasTrackedLaunch(record, launched)) launchSeen = true;
      if (launchSeen && isMainEndTurn(record)) boundarySeen = true;
      return;
    }
    await processRecord(record);
  };

  const processSubagentRecord = async (record: ClaudeRecord | undefined, parentToolCallId: string): Promise<void> => {
    if (!record) return;
    const blocks = contentBlocks(record.message?.content);
    if (record.type === "assistant") {
      for (const block of blocks) {
        if (readString(block, "type") !== "tool_use") continue;
        const toolCallId = readString(block, "id");
        if (!toolCallId) continue;
        const name = readString(block, "name") ?? "Tool";
        const rawInput = (block as Record<string, unknown>).input;
        const previous = toolEvents.get(toolCallId);
        await emitTool({
          ...previous,
          toolCallId,
          parentToolCallId: previous?.parentToolCallId ?? parentToolCallId,
          ...((previous?.isSubagent || isAgentToolName(name)) ? { isSubagent: true } : {}),
          toolName: previous?.toolName ?? name,
          kind: previous?.kind ?? classifyToolKind(name),
          ...(previous?.summary ? { summary: previous.summary } : toolSummary(rawInput) ? { summary: toolSummary(rawInput) } : {}),
          ...(previous?.rawInput !== undefined ? { rawInput: previous.rawInput } : rawInput !== undefined ? { rawInput } : {}),
          status: previous?.status === "success" || previous?.status === "error" ? previous.status : "running",
        });
      }
      return;
    }
    if (record.type !== "user") return;
    for (const block of blocks) {
      if (readString(block, "type") !== "tool_result") continue;
      const toolCallId = readString(block, "tool_use_id");
      if (!toolCallId) continue;
      const previous = toolEvents.get(toolCallId);
      const output = blockText(block);
      const event: ToolUseEvent = {
        ...previous,
        toolCallId,
        parentToolCallId: previous?.parentToolCallId ?? parentToolCallId,
        ...(previous?.isSubagent ? { isSubagent: true } : {}),
        toolName: previous?.toolName ?? "Tool",
        kind: previous?.kind ?? "other",
        ...(previous?.summary ? { summary: previous.summary } : {}),
        ...(previous?.rawInput !== undefined ? { rawInput: previous.rawInput } : {}),
        ...(previous?.rawOutput !== undefined ? { rawOutput: previous.rawOutput } : output ? { rawOutput: output } : {}),
        status: readBoolean(block, "is_error") || previous?.status === "error" ? "error" : "success",
      };
      if (event.isSubagent && isClaudeAsyncAgentLaunch(event)) {
        const agentId = claudeAsyncAgentId(event);
        if (agentId) parentToolCallIdByAgentId.set(agentId, event.toolCallId);
      }
      await emitTool(event);
    }
  };

  const subagentCursors = new Map<string, JsonlCursor>();
  const processSubagentTranscripts = async (): Promise<boolean> => {
    const transcripts = await findSubagentTranscripts(transcriptPath);
    let advanced = false;
    let discoveredNestedAgent = true;
    while (discoveredNestedAgent) {
      const mappedAgentCount = parentToolCallIdByAgentId.size;
      for (const subagent of transcripts) {
        const parentToolCallId = parentToolCallIdByAgentId.get(subagent.agentId);
        if (!parentToolCallId) continue;
        const cursor = subagentCursors.get(subagent.path) ?? { offset: 0, partial: "" };
        const previousOffset = cursor.offset;
        const lines = await readJsonlDelta(subagent.path, cursor);
        if (cursor.offset !== previousOffset) advanced = true;
        subagentCursors.set(subagent.path, cursor);
        for (const line of lines) await processSubagentRecord(parseRecord(line), parentToolCallId);
      }
      discoveredNestedAgent = parentToolCallIdByAgentId.size > mappedAgentCount;
    }
    return advanced;
  };

  // Claude stores each Agent's full trace beside the main transcript. Replay it
  // before the recovered final answer, then keep polling it with the main file.
  await processSubagentTranscripts();

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
        failedToolCallIds: [...failed],
      };
    }

    await waitForPoll(pollIntervalMs, options.signal);
    await processSubagentTranscripts();
    const lines = await readJsonlDelta(transcriptPath, mainCursor);
    for (const line of lines) {
      await processAfterBoundary(parseRecord(line));
      if (done) break;
    }
  }

  // The main transcript and Agent transcripts are separate files, so their
  // writes can become visible in either order. After the main end_turn, allow
  // subagent tails to settle for two polls, with a hard cap on the grace.
  if (parentToolCallIdByAgentId.size > 0) {
    let stablePolls = 0;
    for (let poll = 0; poll < FINAL_SUBAGENT_DRAIN_MAX_POLLS && stablePolls < FINAL_SUBAGENT_DRAIN_STABLE_POLLS; poll += 1) {
      await waitForPoll(pollIntervalMs, options.signal);
      stablePolls = await processSubagentTranscripts() ? 0 : stablePolls + 1;
    }
  }

  return {
    status: "completed",
    transcriptPath,
    completedToolCallIds: [...completed],
    failedToolCallIds: [...failed],
  };
}

async function readJsonlDelta(path: string, cursor: JsonlCursor): Promise<string[]> {
  let size: number;
  try {
    size = (await stat(path)).size;
  } catch {
    return [];
  }
  if (size < cursor.offset) {
    cursor.offset = 0;
    cursor.partial = "";
  }
  if (size <= cursor.offset) return [];

  let chunk: Buffer;
  try {
    const handle = await open(path, "r");
    try {
      chunk = Buffer.alloc(size - cursor.offset);
      const result = await handle.read(chunk, 0, chunk.length, cursor.offset);
      chunk = chunk.subarray(0, result.bytesRead);
    } finally {
      await handle.close();
    }
  } catch {
    return [];
  }
  cursor.offset += chunk.length;
  cursor.partial += chunk.toString("utf8");
  const lines = cursor.partial.split("\n");
  cursor.partial = lines.pop() ?? "";
  return lines;
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

function hasTrackedLaunch(record: ClaudeRecord | undefined, launched: Set<string>): boolean {
  if (record?.type !== "assistant" || record.isSidechain === true) return false;
  return contentBlocks(record.message?.content).some((block) =>
    readString(block, "type") === "tool_use" && launched.has(readString(block, "id") ?? "")
  );
}

function isMainEndTurn(record: ClaudeRecord): boolean {
  return record.type === "assistant" && record.isSidechain !== true && record.message?.stop_reason === "end_turn";
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

function findStringField(value: unknown, keys: ReadonlySet<string>): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findStringField(item, keys);
      if (found) return found;
    }
    return undefined;
  }
  const object = value as Record<string, unknown>;
  for (const key of keys) {
    const candidate = object[key];
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  for (const candidate of Object.values(object)) {
    const found = findStringField(candidate, keys);
    if (found) return found;
  }
  return undefined;
}

function taskNotifications(text: string): Array<{ toolCallId: string; failed: boolean }> {
  const notifications: Array<{ toolCallId: string; failed: boolean }> = [];
  const blocks = [...text.matchAll(/<task-notification>([\s\S]*?)<\/task-notification>/gi)]
    .map((match) => match[1] ?? "");
  for (const block of blocks.length > 0 ? blocks : [text]) {
    const toolCallId = /<tool-use-id>([^<]+)<\/tool-use-id>/i.exec(block)?.[1]?.trim();
    if (!toolCallId) continue;
    const status = /<status>([^<]+)<\/status>/i.exec(block)?.[1]?.trim().toLowerCase();
    notifications.push({
      toolCallId,
      failed: status === "failed" || status === "error" || status === "cancelled" || status === "canceled",
    });
  }
  return notifications;
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

function isAgentToolName(name: string): boolean {
  const normalized = name.trim().toLowerCase();
  return normalized === "agent" || normalized === "task";
}

async function findSubagentTranscripts(transcriptPath: string): Promise<Array<{ agentId: string; path: string }>> {
  const sessionDir = join(dirname(transcriptPath), basename(transcriptPath, ".jsonl"), "subagents");
  const found: Array<{ agentId: string; path: string }> = [];
  const visit = async (directory: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(path);
      } else if (entry.isFile() && entry.name.startsWith("agent-") && entry.name.endsWith(".jsonl")) {
        found.push({ agentId: entry.name.slice("agent-".length, -".jsonl".length), path });
      }
    }
  };
  await visit(sessionDir);
  return found;
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
