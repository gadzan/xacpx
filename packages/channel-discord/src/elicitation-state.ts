/**
 * Server-side pending state for Discord form Elicitation.
 *
 * Answer values live HERE and nowhere else. They must never enter a Discord
 * `custom_id` (a message component id is visible in every interaction payload,
 * gateway log and webhook trace) nor any persisted or loggable surface, so this
 * module is deliberately the only holder: the UI layer receives an opaque token
 * and a routing identity and looks the rest up by token.
 *
 * This mirrors `PendingDiscordPermission` (permission-ui.ts) — same
 * first-terminal-decision rule, same commit-before-ack ordering — but adds
 * multi-field mutable answer state, because Elicitation collects several values
 * over a wizard rather than one binary outcome.
 */
import type {
  ChannelElicitationDecision,
  ChannelElicitationRequest,
  ChannelElicitationValue,
} from "xacpx/plugin-api";

export interface PendingDiscordElicitation {
  /** Opaque correlation handle. Not authorization, never an answer. */
  token: string;
  /** Core broker correlation id, for logs only. */
  requestId: string;
  /** The platform-authenticated initiator every callback is checked against. */
  requesterId: string;
  accountId?: string;
  target: { channelId: string; guildId?: string };
  messageId?: string;
  /** The original request, kept read-only (core froze `fields`). */
  request: ChannelElicitationRequest;
  /**
   * Answers collected so far, keyed by field key. Memory only.
   *
   * NULL-PROTOTYPE, not `{}`: core allows `__proto__`, `constructor` and
   * `toString` as legal field keys, and a plain object would let an inherited
   * `constructor` read back as an answer to a question nobody answered, while
   * assigning `__proto__` would mutate this dictionary's own prototype instead
   * of recording a value. Every read therefore also uses `Object.hasOwn` rather
   * than comparing against `undefined`.
   */
  values: Record<string, ChannelElicitationValue>;
  /**
   * Optional fields the user explicitly left blank.
   *
   * Separate from `values` because the two mean different things to ACP: a key
   * in `values` was ANSWERED (including with an empty string), a key in
   * `skipped` was deliberately NOT. Review-and-modify includes going back to
   * "no answer", and an empty string cannot express that — it is a real answer.
   */
  skipped: Set<string>;
  /**
   * Wizard position. Undefined on the opening card; set once the user starts.
   * Undefined means "the field wizard has not been entered yet", which is a
   * distinct state from "no fields" — a form the user declined from the first
   * card is a decline, not an empty submission.
   */
  currentField?: string;
  /**
   * Which review page the user is on. A form wider than one action row is a
   * navigable list, so the page is state rather than derived from the field.
   */
  reviewPage: number;
  /**
   * Whether the wizard has shown the review page. Distinguishes the review
   * control's two intents (Next forward vs. Edit back) without adding a second
   * control whose action could be confused with a field action.
   */
  visitedReview: boolean;
  settled: boolean;
  /** Terminal UI state for a send that completes after settlement (send race). */
  terminalState?: "expired" | "cancelled";
  resolve: (decision: ChannelElicitationDecision) => void;
  reject: (error: Error) => void;
}

/**
 * Settle entry atomically. Returns true for the caller that won the race.
 *
 * Checking and setting `settled` inside one synchronous function is what makes
 * "first terminal decision wins" real: a duplicate click, a modal that was in
 * flight when the request resolved, and a stop-timeout callback all race here,
 * and only one of them may pass. A check-then-set split across an `await` would
 * let two callbacks through when both were dispatched before either resumed.
 */
export function trySettle(entry: PendingDiscordElicitation): boolean {
  if (entry.settled) return false;
  entry.settled = true;
  return true;
}

/**
 * Create the pending answer map.
 *
 * `Object.create(null)` is the point: field keys are arbitrary JSON property
 * names, so `__proto__` must be a data property rather than a prototype write,
 * and `constructor`/`toString` must not appear to be present when they are not.
 */
export function createAnswerMap(): Record<string, ChannelElicitationValue> {
  return Object.create(null) as Record<string, ChannelElicitationValue>;
}

/** Whether this field has an answer recorded. Presence, never `!== undefined`. */
export function hasAnswer(entry: PendingDiscordElicitation, fieldKey: string): boolean {
  return Object.hasOwn(entry.values, fieldKey);
}

/** Whether the field's outcome is settled — answered or explicitly skipped. */
export function isResolved(entry: PendingDiscordElicitation, fieldKey: string): boolean {
  return Object.hasOwn(entry.values, fieldKey) || entry.skipped.has(fieldKey);
}

/** Record an answer, clearing any earlier skip for the same field. */
export function recordAnswer(
  entry: PendingDiscordElicitation,
  fieldKey: string,
  value: ChannelElicitationValue,
): void {
  entry.values[fieldKey] = value;
  entry.skipped.delete(fieldKey);
}

/**
 * Mark an optional field explicitly unanswered.
 *
 * Deletes any existing answer: ACP's review-and-modify requirement includes
 * going from a value back to omitted, and a Skip that could not clear an earlier
 * answer made that transition impossible.
 */
export function markSkipped(entry: PendingDiscordElicitation, fieldKey: string): void {
  delete entry.values[fieldKey];
  entry.skipped.add(fieldKey);
}

/** Wizard progression over the frozen field list. */
export function firstUnansweredKey(entry: PendingDiscordElicitation): string | undefined {
  return entry.request.fields.find((field) => !Object.hasOwn(entry.values, field.key))?.key;
}

/** The next field the user has not yet chosen an outcome for, if any. */
export function nextUnresolvedKey(entry: PendingDiscordElicitation): string | undefined {
  return entry.request.fields.find((field) => !isResolved(entry, field.key))?.key;
}

export function nextFieldKey(entry: PendingDiscordElicitation): string | undefined {
  const keys = entry.request.fields.map((field) => field.key);
  const index = entry.currentField ? keys.indexOf(entry.currentField) : -1;
  return keys[index + 1];
}

export function isFormComplete(entry: PendingDiscordElicitation): boolean {
  return entry.request.fields.every((field) => Object.hasOwn(entry.values, field.key));
}

/**
 * Number of fields still needing an answer, for the progress line.
 *
 * Optional fields count as "answered" once the wizard has passed them: an
 * optional field the user skipped is an answer (absent), not a blocking hole,
 * and counting it would make the progress line never reach completion.
 */
export function remainingFieldCount(entry: PendingDiscordElicitation): number {
  return entry.request.fields.filter((field) => !Object.hasOwn(entry.values, field.key)).length;
}

/**
 * Build the ACP answer object for a reviewed form.
 *
 * A dict of OWN properties only, with `null` when nothing was answered. The
 * null-prototype output matters: core's own validator builds one for exactly the
 * same reason, and a plain `{}` would let an inherited `toString` be copied into
 * the answer set.
 */
export function buildAnswerContent(
  entry: PendingDiscordElicitation,
): Record<string, ChannelElicitationValue> | null {
  const collected = createAnswerMap();
  for (const field of entry.request.fields) {
    if (!Object.hasOwn(entry.values, field.key)) continue;
    if (entry.skipped.has(field.key)) continue;
    collected[field.key] = entry.values[field.key]!;
  }
  return Object.keys(collected).length === 0 ? null : collected;
}
