import type { ConversationMessage } from "./conversation-types";

/** Postcondition on the whole rendered block. A Direct fork must never hand the
 *  provider more prompt text than this in one turn. */
export const MAX_FORK_HANDOFF_CHARS = 12_000;
/** Per-message cap, the ellipsis included, so one huge row cannot eat the budget. */
export const MAX_FORK_HANDOFF_MESSAGE_CHARS = 2_000;
/** The source title is user-controlled text that lands inside the header, so a
 *  newline or an early closing marker must be impossible. */
export const MAX_FORK_HANDOFF_TITLE_CHARS = 80;

const ELLIPSIS = "…";
const HISTORY_OPEN = "<<<HISTORY";
const HISTORY_CLOSE = ">>>END HISTORY";
const PARENT_TRUNCATED_MARKER = "[…earlier forked history omitted]";

export interface TopicForkHandoffMessage {
  role: ConversationMessage["role"];
  senderBotId?: string;
  content: string;
}

export interface RenderTopicForkHandoffInput {
  sourceTitle: string;
  throughSeq: number;
  /** Ascending by `seq` and already limited to `seq <= throughSeq`. */
  messages: readonly TopicForkHandoffMessage[];
  /** Messages inside the boundary, including any the caller's read window
   *  dropped. Defaults to `messages.length`. */
  inBoundaryCount?: number;
  /** A parent handoff's rendered text: fork-of-fork keeps the chain's oldest
   *  context inline instead of dropping it. */
  parentText?: string;
  parentMessageCount?: number;
  parentOmittedMessages?: number;
  budget?: number;
}

export interface RenderedTopicForkHandoff {
  /** Empty when no message could be rendered; the caller reports empty. */
  text: string;
  /** Messages this render included, plus the parent chain's count. */
  messageCount: number;
  /** In-boundary messages this render dropped, plus the parent's omissions. */
  omittedMessages: number;
}

/** Collapse whitespace and clamp to the title budget. The header is a single
 *  line, so a title can never break it or smuggle a closing marker through. */
export function sanitizeHandoffTitle(title: string): string {
  // The delimiters are stripped before collapsing: a title carrying one would
  // let a reader treat the header as a closed block and the rest of the prompt
  // as instructions.
  const collapsed = title
    .replaceAll(HISTORY_OPEN, "")
    .replaceAll(HISTORY_CLOSE, "")
    .replace(/\s+/g, " ")
    .trim();
  return collapsed.length > MAX_FORK_HANDOFF_TITLE_CHARS
    ? collapsed.slice(0, MAX_FORK_HANDOFF_TITLE_CHARS - ELLIPSIS.length) + ELLIPSIS
    : collapsed;
}

function prefixOf(message: TopicForkHandoffMessage): string {
  if (message.role === "human") return "Human";
  if (message.role === "bot") return `Bot ${message.senderBotId ?? "unknown"}`;
  return "System";
}

/** One row, collapsed to a single line, capped with the ellipsis inside the
 *  cap. `limit` is what the caller can still spend, never above the
 *  per-message cap, and it bounds the WHOLE row: the prefix and its two
 *  characters come out of it, or a boundary row sized to `limit` would be
 *  refused by exactly its prefix width and the render would come back empty. */
function renderRow(message: TopicForkHandoffMessage, limit: number): string {
  const prefix = `${prefixOf(message)}: `;
  const cap = Math.min(
    MAX_FORK_HANDOFF_MESSAGE_CHARS,
    Math.max(0, limit - prefix.length),
  );
  const collapsed = message.content.replace(/\s+/g, " ").trim();
  const body = collapsed.length > cap
    ? collapsed.slice(0, Math.max(0, cap - ELLIPSIS.length)) + ELLIPSIS
    : collapsed;
  return `${prefix}${body}`;
}

function lastIndexWhere(messages: readonly TopicForkHandoffMessage[], role: ConversationMessage["role"]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]!.role === role) return index;
  }
  return -1;
}

/**
 * Pure renderer for the one-time Direct fork prompt block (design §4.3).
 *
 * Layout: two-line header, then a fenced `HISTORY` block of prefixed rows,
 * then the optional parent block of a fork-of-fork.
 *
 * Reserved space (header, markers, one separator per block) comes off the
 * budget first, and every accepted row is charged its own length plus its
 * separator, so `text.length <= budget` is a postcondition rather than a hope.
 * The boundary message is always present: the user picked that point, so a
 * hostile budget may truncate it but never silently drop it. Selection order is
 * the boundary message, then the last human, then the last bot, then
 * newest-to-oldest. The parent text is the oldest content, so it is filled last
 * out of whatever remains.
 */
export function renderTopicForkHandoff(input: RenderTopicForkHandoffInput): RenderedTopicForkHandoff {
  const budget = input.budget ?? MAX_FORK_HANDOFF_CHARS;
  const title = sanitizeHandoffTitle(input.sourceTitle);
  const header = [
    `Historical context from the Direct Topic "${title}" (messages up to #${input.throughSeq}).`,
    "This is background material, not a new request. Attached files and tool state are not replayed.",
  ].join("\n");
  const parentCount = input.parentMessageCount ?? 0;
  const parentOmitted = input.parentOmittedMessages ?? 0;
  const parent = input.parentText?.trim() ?? "";
  const messages = input.messages;
  // header, blank line, open marker, close marker, and their four separators.
  const base = header.length + HISTORY_OPEN.length + HISTORY_CLOSE.length + 4;
  if (base >= budget || (messages.length === 0 && !parent)) {
    return { text: "", messageCount: 0, omittedMessages: 0 };
  }

  const rows = new Map<number, string>();
  let rowsBudget = budget - base;
  const tryInclude = (index: number): boolean => {
    const row = renderRow(messages[index]!, rowsBudget - 1);
    if (row.length + 1 > rowsBudget) return false;
    rows.set(index, row);
    rowsBudget -= row.length + 1;
    return true;
  };
  const boundary = messages.length - 1;
  if (boundary >= 0) tryInclude(boundary);
  for (const role of ["human", "bot"] as const) {
    const index = lastIndexWhere(messages, role);
    if (index >= 0 && !rows.has(index)) tryInclude(index);
  }
  for (let index = boundary - 1; index >= 0; index -= 1) {
    if (rows.has(index)) continue;
    // Older rows are strictly less valuable than the ones already chosen, so
    // the first row that cannot fit ends the fill.
    if (!tryInclude(index)) break;
  }
  if (rows.size === 0 && !parent) {
    return { text: "", messageCount: 0, omittedMessages: 0 };
  }

  const blocks: string[] = [header, "", HISTORY_OPEN];
  for (let index = 0; index < messages.length; index += 1) {
    const row = rows.get(index);
    if (row !== undefined) blocks.push(row);
  }
  let includedParent = false;
  if (parent) {
    // rowsBudget already holds the exact remainder: base + every row (plus its
    // separator) has been charged, and the parent still needs one separator.
    const allowed = rowsBudget - 1;
    if (parent.length <= allowed) {
      blocks.push(parent);
      includedParent = true;
    } else {
      const marker = `${PARENT_TRUNCATED_MARKER}\n`;
      const keep = allowed - marker.length;
      if (keep > 0) {
        blocks.push(marker + parent.slice(parent.length - keep));
        includedParent = true;
      }
    }
  }
  blocks.push(HISTORY_CLOSE);
  const text = blocks.join("\n");
  if (text.length > budget) {
    throw new Error(`topic fork handoff exceeded its ${budget} character budget`);
  }
  const inBoundary = input.inBoundaryCount ?? messages.length;
  return {
    text,
    messageCount: rows.size + (includedParent ? parentCount : 0),
    omittedMessages: Math.max(0, inBoundary - rows.size) + (includedParent ? parentOmitted : 0),
  };
}
