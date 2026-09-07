/**
 * Per-turn, per-toolCallId snapshot normalization for the Runtime engine (spec §5-§7).
 * Accumulates sparse delta updates into full snapshots before yielding to the host/worker.
 */

import type { XacpxRuntimeEvent } from "./runtime-contract.js";
import { isEmptyToolField } from "../../../transport/tool-summary.js";

export interface RuntimeToolCallSnapshot {
  type: "tool_call";
  text: string;
  tag?: string;
  toolCallId: string;
  title?: string;
  status?: string;
  kind?: string;
  locations?: unknown;
  rawInput?: unknown;
  rawOutput?: unknown;
  content?: unknown;
}

export interface RuntimeToolCallInputEvent {
  type: "tool_call";
  text: string;
  tag?: string;
  toolCallId?: string;
  status?: string;
  title?: string;
  kind?: string;
  locations?: unknown;
  rawInput?: unknown;
  rawOutput?: unknown;
  content?: unknown;
}

export function isMeaningfulTitle(title: unknown): title is string {
  if (typeof title !== "string") return false;
  const trimmed = title.trim();
  return trimmed.length > 0 && trimmed.toLowerCase() !== "tool call";
}

export function mergeTitle(
  prevTitle: string | undefined,
  nextTitle: string | undefined,
): string | undefined {
  if (nextTitle === undefined || nextTitle === null || nextTitle.trim().length === 0) {
    return prevTitle;
  }
  const nextTrimmed = nextTitle.trim();
  if (isMeaningfulTitle(nextTrimmed)) {
    return nextTrimmed;
  }
  // nextTitle is a generic placeholder (e.g. "tool call")
  if (isMeaningfulTitle(prevTitle)) {
    return prevTitle;
  }
  return nextTrimmed;
}

export function normalizeRuntimeToolCallEvent(
  toolCalls: Map<string, RuntimeToolCallSnapshot>,
  event: RuntimeToolCallInputEvent,
): XacpxRuntimeEvent {
  const toolCallId = event.toolCallId;
  if (!toolCallId) {
    return {
      type: "tool_call",
      text: event.text,
      ...(event.tag ? { tag: event.tag } : {}),
      ...(event.status ? { status: event.status } : {}),
      ...(event.title ? { title: event.title } : {}),
      ...(event.kind ? { kind: event.kind } : {}),
      ...(event.locations !== undefined ? { locations: event.locations } : {}),
      ...(event.rawInput !== undefined ? { rawInput: event.rawInput } : {}),
      ...(event.rawOutput !== undefined ? { rawOutput: event.rawOutput } : {}),
      ...(event.content !== undefined ? { content: event.content } : {}),
    };
  }

  const prev = toolCalls.get(toolCallId);

  const title = mergeTitle(prev?.title, event.title);

  const text =
    typeof event.text === "string" && event.text.trim().length > 0
      ? event.text
      : (prev?.text ?? event.text ?? "");

  const tag = event.tag ?? prev?.tag;

  const kind = !isEmptyToolField(event.kind) ? event.kind : prev?.kind;
  const status = !isEmptyToolField(event.status) ? event.status : prev?.status;
  const rawInput = !isEmptyToolField(event.rawInput) ? event.rawInput : prev?.rawInput;
  const rawOutput = !isEmptyToolField(event.rawOutput) ? event.rawOutput : prev?.rawOutput;
  const content = !isEmptyToolField(event.content) ? event.content : prev?.content;
  const locations = !isEmptyToolField(event.locations) ? event.locations : prev?.locations;

  const snapshot: RuntimeToolCallSnapshot = {
    type: "tool_call",
    toolCallId,
    text,
    ...(tag ? { tag } : {}),
    ...(title !== undefined ? { title } : {}),
    ...(kind !== undefined ? { kind } : {}),
    ...(status !== undefined ? { status } : {}),
    ...(rawInput !== undefined ? { rawInput } : {}),
    ...(rawOutput !== undefined ? { rawOutput } : {}),
    ...(content !== undefined ? { content } : {}),
    ...(locations !== undefined ? { locations } : {}),
  };

  toolCalls.set(toolCallId, snapshot);
  return snapshot;
}
