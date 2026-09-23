/**
 * Server-side pending state for Feishu form Elicitation.
 *
 * Answer values live HERE and nowhere else. Two Feishu-specific reasons they
 * must:
 *
 *   1. Answers arrive in the callback's `form_value`, keyed by the input/select
 *      component's `name`. The `name` is the field's POSITION (`f0`, `f1`, …) —
 *      the platform requires it be present and unique within the card, and it is
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
  ChannelElicitationField,
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
  /**
   * Fields the user explicitly left blank. Separate from `values` because the
   * two mean different things to ACP: a field in `values` was ANSWERED, a
   * field in `skipped` was deliberately NOT. An empty string in `values` used
   * to play both roles, which made "answered empty" indistinguishable from
   * "skipped", and made a skipped field un-reanswerable once an answer existed.
   */
  skipped: Set<string>;
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
  return entry.request.fields.every((field) => isAnswered(entry, field.key));
}

export function remainingFieldCount(entry: PendingFeishuElicitation): number {
  return entry.request.fields.filter((field) => !isAnswered(entry, field.key)).length;
}

/**
 * Whether a field has a terminal state the user chose — answered or skipped.
 *
 * Progression must treat "skipped" as DONE the same way "answered" is: an
 * optional field the user skipped is behind the wizard, so a loop that asked
 * for "the next unanswered field" would otherwise return to it forever.
 */
export function isAnswered(entry: PendingFeishuElicitation, fieldKey: string): boolean {
  return Object.hasOwn(entry.values, fieldKey) || entry.skipped.has(fieldKey);
}

/** The next field the user has not yet chosen an outcome for, if any. */
export function nextUnresolvedFieldKey(entry: PendingFeishuElicitation): string | undefined {
  return entry.request.fields.find((field) => !isAnswered(entry, field.key))?.key;
}

/**
 * Record an explicit "leave this optional field blank".
 *
 * Deletes any existing answer rather than preserving it: ACP's
 * review-and-modify requirement includes going from a value back to omitted,
 * and a Skip that could not clear an earlier answer made that transition
 * impossible. Idempotent — the same field skipped twice just stays skipped.
 */
export function markSkipped(entry: PendingFeishuElicitation, fieldKey: string): void {
  delete entry.values[fieldKey];
  entry.skipped.add(fieldKey);
}

/**
 * Record an answer, clearing any earlier skip for the same field.
 *
 * The `skipped` entry is removed, not just overwritten, because a field can be
 * skipped, then edited, then submitted — and a stale `skipped` marker would
 * drop the answer at content-build time.
 */
export function recordAnswer(
  entry: PendingFeishuElicitation,
  fieldKey: string,
  value: ChannelElicitationValue,
): void {
  entry.values[fieldKey] = value;
  entry.skipped.delete(fieldKey);
}

/**
 * Build the ACP content object.
 *
 * A field appearing here was ANSWERED, so an empty string the user typed is
 * legitimate and is kept. A SKIPPED field is absent: sending it would answer a
 * question the user declined to answer. When nothing was answered the result is
 * `null` — ACP's "accept with no answers" — which is deliberately distinct from
 * an empty object.
 */
export function buildElicitationContent(
  entry: PendingFeishuElicitation,
): Record<string, ChannelElicitationValue> | null {
  const collected: Record<string, ChannelElicitationValue> = {};
  for (const field of entry.request.fields) {
    if (!Object.hasOwn(entry.values, field.key)) continue;
    if (entry.skipped.has(field.key)) continue;
    const value = entry.values[field.key];
    // The presence check above already excludes "no answer"; this narrows the
    // type without re-reading the meaning of an undefined slot.
    if (value === undefined) continue;
    // A multi-select the user emptied is not an answer the agent asked for.
    if (Array.isArray(value) && value.length === 0) continue;
    collected[field.key] = value;
  }
  return Object.keys(collected).length === 0 ? null : collected;
}

/**
 * The component `name` a field uses inside a `form` container.
 *
 * Feishu requires a non-empty, card-unique name for every interactive component
 * inside a form (error 200530). A schema key is NOT a safe source for one: core
 * guarantees only that it is a bounded JSON property name, so `env.prod`, `a/b`,
 * a key of only punctuation, or a 128-char key are all legal and would each
 * either fail the platform rule or collide after sanitizing. Position is always
 * expressible and always unique.
 *
 * Returns null only when the field is not in the request at all, which the
 * caller treats as unrenderable rather than silently dropping the field.
 */
export function formComponentName(fieldKey: string, fields: readonly ChannelElicitationField[]): string | null {
  const index = fields.findIndex((field) => field.key === fieldKey);
  if (index < 0) return null;
  return `f${index}`;
}

/** The `element_id` for a static markdown element, safely bounded to 20 chars. */
export function cardElementId(label: string): string {
  const sanitized = label.replace(/[^A-Za-z0-9_]/g, "").slice(0, 18);
  return sanitized.length > 0 && /^[A-Za-z]/.test(sanitized) ? sanitized : `el${sanitized}`;
}
