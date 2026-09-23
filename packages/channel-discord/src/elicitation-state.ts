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
  /** Answers collected so far, keyed by field key. Memory only. */
  values: Record<string, ChannelElicitationValue>;
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

/** Wizard progression over the frozen field list. */
export function firstUnansweredKey(entry: PendingDiscordElicitation): string | undefined {
  return entry.request.fields.find((field) => entry.values[field.key] === undefined)?.key;
}

export function nextFieldKey(entry: PendingDiscordElicitation): string | undefined {
  const keys = entry.request.fields.map((field) => field.key);
  const index = entry.currentField ? keys.indexOf(entry.currentField) : -1;
  return keys[index + 1];
}

export function isFormComplete(entry: PendingDiscordElicitation): boolean {
  return entry.request.fields.every((field) => entry.values[field.key] !== undefined);
}

/**
 * Number of fields still needing an answer, for the progress line.
 *
 * Optional fields count as "answered" once the wizard has passed them: an
 * optional field the user skipped is an answer (absent), not a blocking hole,
 * and counting it would make the progress line never reach completion.
 */
export function remainingFieldCount(entry: PendingDiscordElicitation): number {
  return entry.request.fields.filter((field) => entry.values[field.key] === undefined).length;
}
