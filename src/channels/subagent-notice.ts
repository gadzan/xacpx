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
 * line, deduping by toolCallId. A delegation emits once on first sighting and
 * once more on its terminal transition (success/error) — never on repeated
 * `running` updates. Non-subagent events yield nothing.
 */
export class SubagentNoticeTracker {
  private readonly lastEmitted = new Map<string, ToolUseStatus>();

  notice(event: ToolUseEvent): string | null {
    if (!event.isSubagent) return null;
    const previous = this.lastEmitted.get(event.toolCallId);
    if (previous === event.status) return null;
    // Emit on first sighting, or when a terminal state arrives after running.
    if (previous === undefined || event.status !== "running") {
      this.lastEmitted.set(event.toolCallId, event.status);
      return formatSubagentNotice(event);
    }
    return null;
  }
}
