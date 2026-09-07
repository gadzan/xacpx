import type { ToolUseKind } from "../channels/types.js";

export const TOOL_KIND_EMOJI: Record<ToolUseKind, string> = {
  read: "\u{1F4D6}",
  search: "\u{1F50D}",
  execute: "\u{1F4BB}",
  edit: "\u{270F}\u{FE0F}",
  delete: "\u{1F5D1}\u{FE0F}",
  move: "\u{1F4E6}",
  fetch: "\u{1F310}",
  think: "\u{1F9E0}",
  other: "\u{1F527}",
};

export const DEFAULT_TOOL_EMOJI: string = TOOL_KIND_EMOJI.other;
