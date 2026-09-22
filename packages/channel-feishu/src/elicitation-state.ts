/**
 * Server-side pending state for Feishu form Elicitation.
 *
 * Answer values live HERE and nowhere else. Two Feishu-specific reasons they
 * must:
 *
 *   1. Answers arrive in the callback's `form_value`, keyed by the input/select
 *      component's `name`. The `name` is a FIELD KEY the renderer chose — the
 *      platform requires it be present and unique within the card, and it is
 *      echoed back in every callback payload and interaction log. So the key can
 *      be visible; the value must not.
 *   2. The routing token travels in the button's `behaviors[].value`, which
 *      Feishu documents as developer-defined opaque data echoed verbatim at
 *      `action.value`. It is a correlation handle, never an answer, and unlike
 *      a Discord custom_id it can be a whole object — but the same rule applies:
 *      keep it short and put no answer in it.
 *
 * This mirrors `PendingDiscordElicitation` (channel-discord/src/elicitation-state.ts):
 * same first-terminal-decision rule, same atomic settle, same memory-only
 * answers.
 */
import type {
  ChannelElicitationDecision,
  ChannelElicitationRequest,
  ChannelElicitationValue,
} from "xacpx/plugin-api";

export interface PendingFeishuElicitation {
  /** Opaque correlation handle. Not authorization, never an answer. */
  token: string;
  /** Core broker correlation id, for logs only. */
  requestId: string;
  /** The platform-authenticated initiator every callback is checked against. */
  requesterId: string;
  accountId: string;
  /** Feishu chat the card was sent to. */
  chatId: string;
  /** The interactive message id, used to re-render the card in place. */
  messageId?: string;
  /** CardKit card entity id, the handle `card.update` operates on. */
  cardId?: string;
  /** Monotonic per-card sequence; `card.update` requires it strictly increase. */
  sequence: number;
  /** The original request, kept read-only (core froze `fields`). */
  request: ChannelElicitationRequest;
  /** Answers collected so far, keyed by field key. Memory only. */
  values: Record<string, ChannelElicitationValue>;
  currentField?: string;
  settled: boolean;
  /** Terminal UI state for a send that completes after settlement (send race). */
  terminalState?: "expired" | "cancelled";
  resolve: (decision: ChannelElicitationDecision) => void;
  reject: (error: Error) => void;
}

/**
 * Settle atomically; returns true for the caller that won the race.
 *
 * One synchronous check-and-set is what makes "first terminal decision wins"
 * real across every form of duplication Feishu can produce: a double-tapped
 * button, a submit that was in flight when the card was already withdrawn, and
 * a callback that arrives after an abort all converge here.
 */
export function trySettle(entry: PendingFeishuElicitation): boolean {
  if (entry.settled) return false;
  entry.settled = true;
  return true;
}

/** Advance the monotonically increasing update sequence. */
export function nextSequence(entry: PendingFeishuElicitation): number {
  entry.sequence += 1;
  return entry.sequence;
}

export function firstFieldKey(entry: PendingFeishuElicitation): string | undefined {
  return entry.request.fields[0]?.key;
}

export function isFormComplete(entry: PendingFeishuElicitation): boolean {
  return entry.request.fields.every((field) => entry.values[field.key] !== undefined);
}

export function remainingFieldCount(entry: PendingFeishuElicitation): number {
  return entry.request.fields.filter((field) => entry.values[field.key] === undefined).length;
}

/**
 * The component `name` a field uses inside a `form` container.
 *
 * Feishu requires a non-empty, card-unique name for every interactive component
 * inside a form (error 200530), and `element_id` is separately constrained to
 * 20 chars of `[A-Za-z0-9_]`. Field keys come from the ACP schema and could be
 * longer or contain other characters, so they are namespaced and sanitized.
 * Returns null when the key cannot be expressed, which the renderer treats as
 * unrenderable rather than silently renaming a field.
 */
export function formComponentName(fieldKey: string): string | null {
  const sanitized = fieldKey.replace(/[^A-Za-z0-9_]/g, "").slice(0, 16);
  if (sanitized.length === 0) return null;
  return `f${sanitized}`;
}

/** The `element_id` for a static markdown element, safely bounded to 20 chars. */
export function cardElementId(label: string): string {
  const sanitized = label.replace(/[^A-Za-z0-9_]/g, "").slice(0, 18);
  return sanitized.length > 0 && /^[A-Za-z]/.test(sanitized) ? sanitized : `el${sanitized}`;
}
