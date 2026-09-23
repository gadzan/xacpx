/**
 * Feishu form-Elicitation renderer.
 *
 * Implements the M1 plugin contract for Feishu: `requestElicitation()` renders
 * a card for the authenticated initiator, collects answers through verified
 * card callbacks, and resolves the exact prompt turn with one of the three
 * terminal decisions.
 *
 * LIFECYCLE, and why it differs from Discord:
 *
 *   Discord could page a user through a wizard (one field per message, edits
 *   re-rendering in place) because a button click is a standalone interaction.
 *   Feishu's form model is different: answers only arrive name-keyed when the
 *   component sits in a `form` container, and a form submits as a unit. So
 *   Feishu's flow is one card per field, where each field card IS a form whose
 *   Submit both records that field's answer and advances. A review card then
 *   shows everything collected, with one Edit per field to go back.
 *
 * There is no wizard "position" state on the platform side — the renderer keeps
 * `currentField` server-side and rebuilds the card from it, so a stale callback
 * can never move a user to a field the request no longer has.
 *
 * WHAT MAKES THIS SAFE:
 *
 *   - Every callback is authorized against `entry.requesterId` before anything
 *     is read out of it. The operator id is platform-asserted (only Feishu can
 *     produce a body that passes the token/encrypt check), but a leaked routing
 *     token in a screenshot must still not let a third party answer.
 *   - Answers never enter a callback id: they arrive in `form_value` keyed by
 *     the component `name` (the field's position, `f0`/`f1`/…), and live only in
 *     this module's in-memory map.
 *   - External abort (timeout, turn disposal, shutdown) REPLACES the card with
 *     an inert one and rejects the promise — it never fabricates a responder.
 *   - A form the platform cannot express faithfully is refused before anything
 *     is sent, rather than silently reshaped.
 */
import type {
  ChannelElicitationDecision,
  ChannelElicitationField,
  ChannelElicitationRequest,
  ChannelElicitationValue,
} from "xacpx/plugin-api";

import { t as getMessages } from "./i18n/index.js";
import { checkElicitationRenderability } from "./elicitation-limits.js";
import {
  buildElicitationContent,
  createAnswerMap,
  formComponentName,
  isAnswered,
  markSkipped,
  nextSequence,
  nextUnresolvedFieldKey,
  recordAnswer,
  trySettle,
  type PendingFeishuElicitation,
} from "./elicitation-state.js";
import {
  buildElicitationFieldCard,
  buildElicitationOpeningCard,
  buildElicitationReviewCard,
  buildElicitationTerminalCard,
} from "./elicitation-cards.js";

/** What the renderer needs from the channel to send and update cards. */
export interface FeishuCardTransport {
  /** Create a card entity and send it to a chat; returns both handles. */
  sendCard(input: {
    card: Record<string, unknown>;
    chatId: string;
    replyToMessageId?: string;
  }): Promise<{ cardId: string; messageId: string }>;
  /** Replace a card's content, disabling its interactions. */
  updateCard(input: { cardId: string; sequence: number; card: Record<string, unknown> }): Promise<void>;
}

/**
 * The narrow slice of the Feishu SDK the transport needs is declared once in
 * send.ts as `FeishuMessageClient` (widened there to cover `cardkit` and
 * interactive messages). Duplicating it here would let the two drift, and a
 * drift is exactly how a SDK change becomes a runtime `undefined` instead of a
 * type error.
 */

export interface FeishuElicitationRendererOptions {
  transport: FeishuCardTransport;
  /** Pending map, owned by the channel so stop/logout can drain it. */
  pending: Map<string, PendingFeishuElicitation>;
  log?: (event: string, message: string, fields?: Record<string, string | number | boolean | undefined>) => void;
}

/** A verified card callback, normalized for the renderer. */
export interface FeishuElicitationAction {
  openId: string;
  /** The routing payload the renderer put in `behaviors[].value`. */
  value: Record<string, unknown>;
  /** Name-keyed answers from the submitted form. */
  formValues: Record<string, string>;
}

export function createElicitationToken(): string {
  // 32 hex chars, matching the Discord renderer's token shape.
  return cryptoRandomId();
}

function cryptoRandomId(): string {
  const nodeCrypto = globalThis.crypto;
  if (nodeCrypto && typeof nodeCrypto.randomUUID === "function") {
    return nodeCrypto.randomUUID().replace(/-/g, "");
  }
  // Deterministic-looking fallback is not acceptable for a correlation handle;
  // absence of Web Crypto in a Node runtime is a broken environment.
  throw new Error("crypto.randomUUID unavailable: cannot mint an elicitation token");
}

/**
 * Read the action a verified callback carries.
 *
 * Returns null when the payload was not produced by this renderer — a scalar or
 * missing `action.value` means the callback belongs to some other feature, and
 * guessing at it would let unrelated clicks drive an elicitation.
 */
export function parseElicitationAction(payloadValue: unknown): { token: string; action: string; fieldIndex?: number } | null {
  if (typeof payloadValue !== "object" || payloadValue === null || Array.isArray(payloadValue)) return null;
  const record = payloadValue as Record<string, unknown>;
  const token = record.t;
  const action = record.a;
  if (typeof token !== "string" || token.length === 0) return null;
  if (typeof action !== "string" || action.length === 0) return null;
  // Positional, like Discord: a schema key is not a valid routing id.
  const fieldIndex = record.f;
  return {
    token,
    action,
    ...(typeof fieldIndex === "number" && Number.isInteger(fieldIndex) && fieldIndex >= 0 ? { fieldIndex } : {}),
  };
}

/**
 * Convert a submitted form value into the answer for one field.
 *
 * Type-directed and NON-COERCING. Text is passed through EXACTLY as typed:
 * `raw.trim()` would make `"  foo  "` and `"foo"` the same answer, while core
 * compares the raw string, so a trimmed value is either rejected as something
 * the user never typed or silently rewritten. Only number parsing trims, and
 * only because `Number(" 4 ")` is a spelling of the value rather than the
 * value itself.
 *
 * An empty string is a LEGAL ANSWER (`minLength: 0`) and is preserved. "No
 * answer" is tracked separately (the field is absent from `values`), so the
 * two are never conflated.
 */
export function parseFormAnswer(field: ChannelElicitationField, raw: string): ChannelElicitationValue | undefined {
  switch (field.kind) {
    case "number": {
      const trimmed = raw.trim();
      if (trimmed.length === 0) return undefined;
      const parsed = Number(trimmed);
      if (!Number.isFinite(parsed)) return undefined;
      if (field.integer && !Number.isInteger(parsed)) return undefined;
      if (field.minimum !== undefined && parsed < field.minimum) return undefined;
      if (field.maximum !== undefined && parsed > field.maximum) return undefined;
      return parsed;
    }
    case "boolean": {
      const trimmed = raw.trim();
      if (/^(true|yes|y|1)$/i.test(trimmed)) return true;
      if (/^(false|no|n|0)$/i.test(trimmed)) return false;
      return undefined;
    }
    default:
      // Text: exactly what the user typed, including an empty string.
      return raw;
  }
}

/**
 * The Feishu renderer.
 *
 * One instance per channel, holding no per-request state: everything lives in
 * the `pending` map the channel owns, so shutdown can drain it.
 */
export class FeishuElicitationRenderer {
  private readonly options: FeishuElicitationRendererOptions;

  constructor(options: FeishuElicitationRendererOptions) {
    this.options = options;
  }

  /**
   * Render a form Elicitation and resolve the exact prompt turn.
   *
   * Rejects — never resolves — for anything that is not a user's own
   * authenticated Decline / Cancel / Submit. Core settles its own terminal
   * `cancel` for external aborts, so no responderId is ever invented here.
   */
  async requestElicitation(request: ChannelElicitationRequest, chatId: string): Promise<ChannelElicitationDecision> {
    const verdict = checkElicitationRenderability(request.fields);
    if (!verdict.renderable) {
      this.options.log?.("feishu.elicitation.unsupported", "cancelled unrenderable elicitation", {
        requestId: request.requestId,
        reason: verdict.reason ?? "unknown",
        detail: verdict.detail ?? "",
      });
      throw new Error(`elicitation form is not renderable on Feishu: ${verdict.reason ?? "unknown"}`);
    }

    const token = createElicitationToken();
    const opening = buildElicitationOpeningCard(request, token);

    let settle: (decision: ChannelElicitationDecision) => void = () => {};
    let rejectPromise: (error: Error) => void = () => {};
    const done = new Promise<ChannelElicitationDecision>((resolve, reject) => {
      settle = resolve;
      rejectPromise = reject;
    });
    void done.catch(() => {});

    const entry: PendingFeishuElicitation = {
      token,
      requestId: request.requestId,
      requesterId: request.requester.senderId,
      accountId: request.accountId ?? "",
      chatId,
      sequence: 0,
      request,
      values: createAnswerMap(),
      skipped: new Set<string>(),
      settled: false,
      resolve: settle,
      reject: rejectPromise,
    };
    this.options.pending.set(token, entry);

    try {
      const sent = await this.options.transport.sendCard({
        card: opening,
        chatId,
        ...(request.replyContextToken ? { replyToMessageId: request.replyContextToken } : {}),
      });
      if (entry.settled) {
        // The turn settled while the send was in flight (an abort that landed
        // during the card.create round trip). The card now exists but nobody
        // will read it, so withdraw it rather than leaving a live form.
        entry.cardId = sent.cardId;
        entry.messageId = sent.messageId;
        await this.withdraw(entry, "cancelled");
        throw new Error("elicitation aborted before the card was sent");
      }
      entry.cardId = sent.cardId;
      entry.messageId = sent.messageId;
      this.options.log?.("feishu.elicitation.sent", "sent feishu elicitation request", {
        requestId: request.requestId,
      });
    } catch (error) {
      if (!entry.settled) trySettle(entry);
      this.options.pending.delete(token);
      throw error;
    }

    try {
      const decision = await done;
      this.options.log?.("feishu.elicitation.resolved", "feishu elicitation resolved", {
        requestId: request.requestId,
        action: decision.action,
      });
      return decision;
    } finally {
      this.options.pending.delete(token);
    }
  }

  /**
   * Handle one verified card callback.
   *
   * Authorization happens FIRST and independently of the action: a callback from
   * anyone but the recorded initiator is dropped without touching state, so the
   * initiator can still answer afterwards. There is no owner override in v1.
   */
  async handleAction(action: FeishuElicitationAction): Promise<{ handled: boolean; settled: boolean }> {
    const parsed = parseElicitationAction(action.value);
    if (!parsed) return { handled: false, settled: false };
    const entry = this.options.pending.get(parsed.token);
    if (!entry) return { handled: false, settled: false };
    if (entry.settled) return { handled: false, settled: false };
    if (action.openId !== entry.requesterId) {
      this.options.log?.("feishu.elicitation.unauthorized", "unauthorized elicitation control", {
        requestId: entry.requestId,
      });
      return { handled: false, settled: false };
    }

    switch (parsed.action) {
      case "start": {
        entry.currentField = entry.request.fields[0]?.key;
        if (entry.currentField === undefined) {
          // A zero-field form has nothing to ask, but it is NOT a dead end: M1
          // keeps `accept` + `content: null` precisely for this, so Start goes
          // straight to the review page where Submit is the only way to accept.
          await this.renderReview(entry);
          return { handled: true, settled: false };
        }
        await this.renderCurrentField(entry);
        return { handled: true, settled: false };
      }
      case "field": {
        // Review-page Edit: move to the named field. Routed by POSITION, since a
        // schema key is not a valid routing id.
        if (parsed.fieldIndex !== undefined && entry.request.fields[parsed.fieldIndex]) {
          entry.currentField = entry.request.fields[parsed.fieldIndex]!.key;
          await this.renderCurrentField(entry);
        }
        return { handled: true, settled: false };
      }
      case "skip": {
        // An explicit "leave this field blank", including clearing an answer the
        // user already gave: value -> omitted is part of review-and-modify.
        if (entry.currentField !== undefined) {
          markSkipped(entry, entry.currentField);
        }
        const next = nextUnresolvedFieldKey(entry);
        if (next) {
          entry.currentField = next;
          await this.renderCurrentField(entry);
          return { handled: true, settled: false };
        }
        await this.renderReview(entry);
        return { handled: true, settled: false };
      }
      // Field page "save" and review page "submit" are DIFFERENT ACTIONS. They
      // used to share `a:"submit"` and were told apart by mutable
      // `entry.visitedReview`, which was a real bug: the callback that flips the
      // flag to true also renders the review card, so a redelivery or
      // double-click of that same callback reached the review branch on its
      // second delivery and accepted the form without any click on the review
      // page. Feishu retries callbacks, and a user double-taps.
      case "save": {
        return this.submit(entry, action.formValues);
      }
      case "submit": {
        return this.confirmReviewed(entry);
      }
      case "decline":
      case "cancel": {
        if (!trySettle(entry)) return { handled: false, settled: false };
        const decision: ChannelElicitationDecision = {
          action: parsed.action,
          responderId: action.openId,
        };
        this.options.pending.delete(parsed.token);
        // The card must show what the user actually chose. `withdraw` used to
        // translate any "terminal" into "accepted", so declining rendered an
        // accepted card and cancelling rendered an accepted one too — the exact
        // opposite of the decision, while the protocol decision was correct.
        await this.withdraw(entry, parsed.action === "decline" ? "declined" : "cancelled");
        entry.resolve(decision);
        return { handled: true, settled: true };
      }
      default:
        return { handled: false, settled: false };
    }
  }

  /**
   * Record the submitted field, then ADVANCE. Never settles.
   *
   * The field card's submit saves that field and moves to the next unanswered
   * one, so an optional field is reachable exactly like a required one. Only the
   * REVIEW page's submit settles — which is what the ACP requirement to
   * review-and-modify-before-sending actually means. The previous behaviour
   * settled as soon as every required field was answered, so optional fields
   * were unreachable and no review ever happened.
   */
  private async submit(
    entry: PendingFeishuElicitation,
    formValues: Record<string, string>,
  ): Promise<{ handled: true; settled: false }> {
    if (entry.currentField !== undefined) {
      const field = entry.request.fields.find((f) => f.key === entry.currentField);
      if (field) {
        const name = formComponentName(field.key, entry.request.fields);
        const raw = name !== null ? formValues[name] : undefined;
        // A single-select contributes to form_value under its `name` too, so the
        // same conversion covers it: an option VALUE is already a string.
        const value = raw === undefined ? undefined : parseFormAnswer(field, raw);
        if (value !== undefined) {
          recordAnswer(entry, field.key, value);
        }
      }
    }
    const next = nextUnresolvedFieldKey(entry);
    if (next) {
      entry.currentField = next;
      await this.renderCurrentField(entry);
      return { handled: true, settled: false };
    }
    // Everything has an outcome (answered or explicitly skipped): show the
    // review page, which is the only path to accept.
    await this.renderReview(entry);
    return { handled: true, settled: false };
  }

  /**
   * Commit a reviewed form as an ACP accept. Called ONLY from the review page's
   * submit control, so a user always confirms what they are about to send.
   */
  private async confirmReviewed(
    entry: PendingFeishuElicitation,
  ): Promise<{ handled: boolean; settled: boolean }> {
    const missing = entry.request.fields.filter(
      (field) => field.required && !isAnswered(entry, field.key),
    );
    if (missing.length > 0) {
      // Stay on the unanswered field and let the user fix it.
      entry.currentField = missing[0]!.key;
      await this.renderCurrentField(entry);
      return { handled: true, settled: false };
    }
    if (!trySettle(entry)) return { handled: false, settled: false };
    this.options.pending.delete(entry.token);
    // The user's OWN decision is what the terminal card must show. `withdraw`
    // used to hard-code "accepted", so a Decline or a Cancel rendered an
    // accepted card — the opposite of what the user just chose.
    await this.withdraw(entry, "accepted");
    const content = buildElicitationContent(entry);
    entry.resolve({ action: "accept", responderId: entry.requesterId, content });
    return { handled: true, settled: true };
  }

  /** Re-render the card for the current field, in place. */
  private async renderCurrentField(entry: PendingFeishuElicitation): Promise<void> {
    if (!entry.cardId || entry.settled) return;
    const key = entry.currentField;
    if (key === undefined) return;
    const field = entry.request.fields.find((f) => f.key === key);
    if (!field) return;
    const card = buildElicitationFieldCard(
      entry.request,
      entry.token,
      field,
      entry.request.fields.indexOf(field) + 1,
      entry.values[field.key],
    );
    try {
      await this.options.transport.updateCard({
        cardId: entry.cardId,
        sequence: nextSequence(entry),
        card,
      });
    } catch (error) {
      // A failed re-render is not a decision: the card stays live and the user
      // can retry, so the request is unsettled and Feishu's own retry applies.
      this.options.log?.("feishu.elicitation.update_failed", "failed to update elicitation card", {
        requestId: entry.requestId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Replace the card with an inert, interaction-free one showing the given
   * terminal state. Every caller passes the reason the request ended.
   */
  private async withdraw(
    entry: PendingFeishuElicitation,
    kind: "accepted" | "declined" | "cancelled" | "expired",
  ): Promise<void> {
    if (!entry.cardId) return;
    const card = buildElicitationTerminalCard(kind);
    try {
      await this.options.transport.updateCard({
        cardId: entry.cardId,
        sequence: nextSequence(entry),
        card,
      });
    } catch (error) {
      this.options.log?.("feishu.elicitation.update_failed", "failed to withdraw elicitation card", {
        requestId: entry.requestId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * External withdrawal: timeout, abort, or channel stop.
   *
   * Rejects rather than resolving — an external abort is not a user decision,
   * so it must not carry a responderId.
   */
  async withdrawPending(entry: PendingFeishuElicitation, reason: string): Promise<void> {
    if (!trySettle(entry)) return;
    entry.terminalState = "cancelled";
    this.options.pending.delete(entry.token);
    await this.withdraw(entry, "cancelled");
    entry.reject(new Error(reason));
  }

  /**
   * Replace the card with the review page: every label with its current value,
   * plus one Edit per field and the Submit that confirms what is being sent.
   */
  private async renderReview(entry: PendingFeishuElicitation): Promise<void> {
    if (!entry.cardId || entry.settled) return;
    const card = buildElicitationReviewCard(entry.request, entry.token, entry.values);
    try {
      await this.options.transport.updateCard({
        cardId: entry.cardId,
        sequence: nextSequence(entry),
        card,
      });
    } catch (error) {
      this.options.log?.("feishu.elicitation.update_failed", "failed to render review card", {
        requestId: entry.requestId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
