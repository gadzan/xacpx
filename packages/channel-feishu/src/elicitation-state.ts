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
  /**
   * The generation of the highest card KNOWN to have reached the platform.
   *
   * Every field render stamps the generation it was allocated into the controls
   * it draws, and this is the value the fence compares against. A callback
   * carrying an OLDER generation comes from a card the user has already navigated
   * away from, and honouring it would let a replayed value overwrite a newer
   * answer: Feishu retries callbacks, users double-tap, and `submit()` writes to
   * whichever field the cursor is on — which entering Review does NOT clear,
   * because the review page needs the cursor to know where an Edit lands.
   *
   * Raised by an update that succeeded, and by a signed callback carrying a
   * HIGHER generation (see `renderGenerationCounter`). NEVER lowered, not even by
   * a failed update: a failure is not evidence the card did not reach the
   * platform, so lowering it would re-fence a card the user may still be looking
   * at.
   *
   * Starting at 1, not 0: generation 0 would make the FIRST field card's controls
   * indistinguishable from a payload with no generation at all.
   */
  renderGeneration: number;
  /**
   * The allocation high-water mark for card generations.
   *
   * Separated from `renderGeneration` because the two answer different questions
   * and cannot be synthesised into one number. `renderGenerationCounter` answers
   * "what is the next unused revision", and `renderGeneration` answers "what is
   * the newest revision known to be on the platform". One render can hold a
   * number the platform has not confirmed, and a confirmed card can be newer than
   * the last one this process sent — an acknowledgement can also be lost while
   * the update landed.
   *
   * Monotonic and NEVER reused, on either path. An update that provably failed
   * leaves a gap in the numbering, which costs nothing; reissuing the same
   * revision for a different render would make two cards share a revision ID and
   * destroy the fence's only guarantee. `updateCard()` throwing is not evidence
   * the platform did not apply the card, so the number cannot be reclaimed.
   */
  renderGenerationCounter: number;
  /**
   * The field the wizard is currently asking about, or `undefined` before Start.
   *
   * Deliberately NOT cleared by entering the review page: an Edit has to know
   * where to land, and a replayed save arriving in that window has to write to the
   * field it came from rather than wherever the cursor happens to be. The
   * generation fence, not cursor hygiene, is what keeps such a replay harmless.
   */
  currentField: string | undefined;
  /**
   * Set when a callback advanced the wizard while the opening send was still in
   * flight.
   *
   * The card is visible to the user the moment Feishu delivers it, but `cardId`
   * is not recorded until `sendCard` resolves. A `start`/`field`/`skip` callback
   * arriving in that window would set the cursor and then return immediately from
   * `renderCurrentField` (no id to update), so the user's click was acknowledged
   * and then lost — they were left on the opening card with no visible change and
   * had to click again. `requestElicitation` replays the render once the id
   * exists.
   */
  pendingRender?: boolean;
  settled: boolean;
  /**
   * Terminal UI state, set by whichever path settled this request.
   *
   * EXTERNAL settlements (abort, expiry, send failure) record
   * `"expired"`/`"cancelled"` here. A USER decision does NOT set this — it records
   * its own action in `decisionAction` and the decision itself in `decision`
   * instead. The distinction is load-bearing for the send race: a `sendCard` still
   * in flight must not read a user settlement as an external abort and reject the
   * turn, so the two have to be distinguishable.
   */
  terminalState?: "expired" | "cancelled";
  /** The user's own terminal action, when the settlement was a user decision. */
  decisionAction?: "accept" | "decline" | "cancel";
  /**
   * The user's decision, recorded when it was made.
   *
   * The send race needs it: by the time the in-flight `sendCard` returns, the
   * `done` promise has already resolved with this decision, so `requestElicitation`
   * returns it directly instead of letting its own control flow replace a
   * resolution with a rejection.
   */
  decision?: ChannelElicitationDecision;
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

/**
 * Allocate the next card generation.
 *
 * A dedicated allocator rather than `entry.renderGeneration + 1` at the call
 * site, because the ONLY property that matters is uniqueness: a generation is a
 * revision ID, and two cards sharing one makes the replay fence unable to tell
 * them apart. The counter therefore never goes back and a number is never
 * reissued, on any path — including a render whose update provably failed,
 * because a failure is not evidence the card did not reach the platform.
 *
 * Gaps are the accepted cost. A failed render consumes a number that no card
 * uses, which costs nothing observable; reusing a number would cost correctness.
 */
export function nextGeneration(entry: PendingFeishuElicitation): number {
  entry.renderGenerationCounter += 1;
  return entry.renderGenerationCounter;
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
 * Create the pending answer map.
 *
 * `Object.create(null)` is the point: field keys are arbitrary JSON property
 * names, so `__proto__` must become a data property rather than a prototype
 * write, and `constructor`/`toString` must not appear present when they are not.
 * Presence checks use `Object.hasOwn` everywhere rather than comparing against
 * `undefined`.
 */
export function createAnswerMap(): Record<string, ChannelElicitationValue> {
  return Object.create(null) as Record<string, ChannelElicitationValue>;
}

/**
 * Build the ACP content object.
 *
 * A field appearing here was ANSWERED, so an empty string the user typed is
 * legitimate and is kept. A SKIPPED field is absent: sending it would answer a
 * question the user declined to answer. When nothing was answered the result is
 * `null` — ACP's "accept with no answers" — which is deliberately distinct from
 * an empty object.
 *
 * Own properties only, on a null-prototype map: a plain `{}` would let an
 * inherited `toString` be copied into the answer set, and core rejects keys it
 * was not asked for.
 */
export function buildElicitationContent(
  entry: PendingFeishuElicitation,
): Record<string, ChannelElicitationValue> | null {
  const collected = createAnswerMap();
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
