import type { ToolUseEvent, ToolUseStatus } from "./types.js";

// Text-only channels (WeChat, Yuanbao) can't render the web/Feishu subagent
// card, so they degrade to a single honest line per delegation. Only
// `isSubagent` events surface — ordinary tool calls stay hidden to avoid
// flooding a linear text chat. The line never claims child activity it can't
// prove (see the unified-subagent-presentation spec).

const NOTICE_MAX_TITLE = 120;

function statusWord(status: ToolUseStatus): string {
  return status === "running" ? "running" : status === "error" ? "failed" : "done";
}

function truncateTitle(text: string): string {
  return text.length > NOTICE_MAX_TITLE ? `${text.slice(0, NOTICE_MAX_TITLE - 1)}…` : text;
}

/** Render a compact one-line notice for a subagent delegation event. */
export function formatSubagentNotice(event: ToolUseEvent): string {
  const title = (event.summary?.trim() || event.toolName || "subagent").trim();
  return `↳ [subagent] ${truncateTitle(title)} (${statusWord(event.status)})`;
}

/**
 * Per-turn accumulator that decides when a subagent event warrants a notice
 * line, deduping by toolCallId. Each delegation surfaces exactly once — on its
 * first sighting, whatever status that is (a delegation first seen already
 * terminal still gets its single line). Every later frame for the same id is
 * swallowed, so a `running → success` pair never doubles up. Non-subagent
 * events yield nothing.
 */
export class SubagentNoticeTracker {
  private readonly emitted = new Set<string>();

  notice(event: ToolUseEvent): string | null {
    if (!event.isSubagent) return null;
    if (this.emitted.has(event.toolCallId)) return null;
    this.emitted.add(event.toolCallId);
    return formatSubagentNotice(event);
  }
}
