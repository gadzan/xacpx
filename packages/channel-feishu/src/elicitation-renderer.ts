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
import {
  checkElicitationRenderability,
  fitsCardBudget,
  findRejectedAnswer,
} from "./elicitation-limits.js";
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
  buildWorstCaseReviewCard,
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
export function parseElicitationAction(
  payloadValue: unknown,
): { token: string; action: string; fieldIndex?: number; renderGeneration?: number } | null {
  if (typeof payloadValue !== "object" || payloadValue === null || Array.isArray(payloadValue)) return null;
  const record = payloadValue as Record<string, unknown>;
  const token = record.t;
  const action = record.a;
  if (typeof token !== "string" || token.length === 0) return null;
  if (typeof action !== "string" || action.length === 0) return null;
  // Positional, like Discord: a schema key is not a valid routing id.
  const fieldIndex = record.f;
  const positional = typeof fieldIndex === "number" && Number.isInteger(fieldIndex) && fieldIndex >= 0 ? fieldIndex : undefined;
  // The card generation the control was rendered on.
  //
  // REQUIRED on the actions that mutate field state. The builder always stamps a
  // generation onto Save and Skip, so a callback without one cannot have come from
  // a card this renderer drew — and honouring it would let a payload bypass the
  // revision fence entirely. Rejecting at the parser keeps the fence an invariant
  // of the protocol instead of a property of the situation.
  //
  // Terminal decisions (decline/cancel) and navigation (start/field/submit)
  // carry no generation by design: a replayed Decline is still a Decline, and the
  // review page is not versioned.
  const generation = record.g;
  const renderGeneration = typeof generation === "number" && Number.isInteger(generation) && generation >= 0
    ? generation
    : undefined;
  // `skip` MUST carry a position. Resolving it from mutable renderer state is
  // what let a retried or double-tapped Skip act on a different field than the
  // button that produced the callback, so a positionless Skip is rejected
  // outright rather than silently reinterpreted.
  if (action === "skip" && positional === undefined) return null;
  // `save` and `skip` both write to recorded field state, so both MUST be
  // versioned. See above.
  if ((action === "save" || action === "skip") && renderGeneration === undefined) return null;
  return {
    token,
    action,
    ...(positional !== undefined ? { fieldIndex: positional } : {}),
    ...(renderGeneration !== undefined ? { renderGeneration } : {}),
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
    // A form is PRIVATE TO ITS REQUESTER, and the destination has to prove it.
    //
    // The card carries the agent's question AND the user's answers, and a group
    // chat shows both to every member — so an elicitation asked in a group
    // publishes what the user told the agent. Authorising who may CLICK never
    // limited who may SEE, which is a different and much wider audience.
    //
    // `chatType` is the channel's own ingress fact, not a guess made here, which
    // is why this needs no extra REST lookup of the chat type. Anything other than
    // `"direct"` — including a channel that reports nothing — fails closed: only a
    // provably 1:1 destination may render a form. The check runs before the card
    // is built, so no question and no answer can reach a group.
    //
    // `elicitationModes` stays `["form"]` at channel scope because the plugin
    // capability contract has no route-scoped notion; this per-turn refusal is what
    // closes the gap.
    if (request.chatType !== "direct") {
      this.options.log?.("feishu.elicitation.route_not_private", "refused elicitation on a non-private route", {
        requestId: request.requestId,
        chatType: request.chatType ?? "unreported",
      });
      throw new Error(
        `elicitation form is only renderable on a private route; this turn reported ${request.chatType ?? "no chatType"}`,
      );
    }
    // The request is passed alongside the fields so the gate can also measure
    // the opening card's agent-authored text (message, schema title and
    // description) in ESCAPED space. Without it, a high-expansion question —
    // 8000 `<` becomes ~40000 chars of entities — would pass the gate and then
    // be cut by the markdown component's own bound, leaving the user with a
    // question that contains none of its original characters.
    const verdict = checkElicitationRenderability(request.fields, request);
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

    // THE OPENING CARD'S OWN 30 KB BUDGET. The per-component gate above bounds
    // each markdown component independently (28,000 chars), but the card budget
    // is an AGGREGATE over the whole serialized card — chrome, header, every
    // component, and the JSON envelope together. Several individually legal
    // pieces therefore still overflow: a 4,666-char `~` message escapes to
    // 27,996 chars (just inside the per-component bound) alongside a 1,000-char
    // `~` schema description at 6,000 gives 33,996 chars of content before a
    // single byte of card structure, so the card is ~35 KB.
    //
    // Checked here rather than in the field-level gate because the size is a
    // property of the BUILT card, and this is the earliest point at which the
    // real thing exists — before `sendCard`, so a refusal costs the operator
    // nothing and the user never sees a half-sent question.
    const openingVerdict = fitsCardBudget(opening);
    if (!openingVerdict.renderable) {
      this.options.log?.("feishu.elicitation.unsupported", "cancelled unrenderable elicitation", {
        requestId: request.requestId,
        reason: openingVerdict.reason ?? "unknown",
        detail: openingVerdict.detail ?? "",
      });
      throw new Error(`elicitation form is not renderable on Feishu: ${openingVerdict.reason ?? "unknown"}`);
    }

    // The review card is where a form can grow past Feishu's 30 KB card budget:
    // every field's label and answer lands in one card, and the escaped form of
    // an answer can be several times its raw length. Sizing the WORST-CASE
    // review here, before anything is sent, is what keeps this from being a
    // `card.update` failure after the user has filled the whole form in.
    const worstReview = buildWorstCaseReviewCard(request, token);
    const reviewVerdict = fitsCardBudget(worstReview);
    if (!reviewVerdict.renderable) {
      this.options.log?.("feishu.elicitation.unsupported", "cancelled unrenderable elicitation", {
        requestId: request.requestId,
        reason: reviewVerdict.reason ?? "unknown",
        detail: reviewVerdict.detail ?? "",
      });
      throw new Error(`elicitation form is not renderable on Feishu: ${reviewVerdict.reason ?? "unknown"}`);
    }

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
      currentField: undefined,
      // 1, not 0: generation 0 is what a payload with NO generation decodes to,
      // so starting at 1 keeps "the first field card" distinguishable from a
      // control that never carried a generation at all.
      renderGeneration: 1,
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
      // OWNERSHIP OF THE SEND FIRST, THEN SETTLEMENT.
      //
      // A successful `sendCard` is an external fact — the card exists in the chat
      // and the daemon now owns it. Recording it before looking at `settled` is
      // what keeps a user decision from being misread as an abort: the same
      // ordering bug Discord had, where the FINAL send landing after a Decline
      // threw "aborted" and a legitimate decision was reported as a rejection.
      entry.cardId = sent.cardId;
      entry.messageId = sent.messageId;
      if (entry.settled) {
        // The turn settled while the send was in flight. WHICH kind of settlement
        // matters, because they end the turn differently:
        //
        //   - a USER decision (decline/cancel/accept): `handleAction` already
        //     RESOLVED the promise. The awaiting turn must keep that decision.
        //     Rejecting here is what turned a legitimate Decline into a core-side
        //     cancel, and rewriting the card as "cancelled" told the user they
        //     cancelled something they declined.
        //   - an EXTERNAL withdrawal (timeout, abort, channel stop): the promise
        //     was REJECTED, and the card is now a live form nobody will answer, so
        //     it must be withdrawn and this call must throw.
        //
        // `terminalState` is the discriminator: only the external paths set it. A
        // user decision records its action in `decisionAction` instead.
      this.options.pending.delete(token);
      if (entry.terminalState !== undefined) {
        const terminal = entry.terminalState;
        await this.withdraw(entry, terminal === "expired" ? "expired" : "cancelled");
        throw new Error("elicitation aborted before the card was sent");
      }
      // The user already decided: their terminal render ran before `cardId`
      // existed and returned immediately, so publish the outcome they chose now
      // that the card can be updated.
      //
      // RETURN the decision rather than throwing. `requestElicitation` is the
      // one call the bridge awaits, and by this point `done` is already
      // resolved with the user's decision — but this method's control flow is
      // still inside the SEND's try block, so a throw here would replace that
      // resolution with a rejection. The send is no longer part of the turn's
      // outcome; the decision is, and it has to be what comes back out.
      //
      // The terminal update is FIRE-AND-FORGET, not awaited. `withdraw` is a
      // `card.update` round trip, and holding the turn's return value behind it
      // re-introduces exactly the defect the decision paths fix: a CardKit
      // request that never returns would swallow a Decline the user already
      // made. The decision is in hand; the card is cosmetic, and it may finish
      // settling after this method has already returned it.
      const action = entry.decisionAction;
      const decision = entry.decision;
      if (decision === undefined) {
        throw new Error("elicitation settled while its card was being sent");
      }
      void this.withdraw(
        entry,
        action === "decline" ? "declined" : action === "accept" ? "accepted" : "cancelled",
      ).catch(() => {});
      return decision;
      }
      this.options.log?.("feishu.elicitation.sent", "sent feishu elicitation request", {
        requestId: request.requestId,
      });
      // A callback that advanced the wizard while the send was in flight could
      // not render (no card id yet). Now that the id exists, honour it — otherwise
      // the user's click was acknowledged and then silently lost, leaving them on
      // the opening card to click again.
      if (entry.pendingRender && !entry.settled) {
        entry.pendingRender = false;
        if (entry.currentField === undefined) {
          await this.renderReview(entry);
        } else {
          await this.renderCurrentField(entry);
        }
      }
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
    // CARD REVISION FENCE.
    //
    // Every re-render draws a card stamped with its own generation and commits it
    // to the entry only once the update has landed (see `renderCurrentField`). A
    // callback carrying an OLDER generation comes from a card the user has already
    // navigated away from, and honouring it would let a replayed value or a
    // replayed Skip overwrite a newer answer: Feishu retries callbacks, users
    // double-tap, and every state-mutating control writes wherever the cursor is.
    //
    // Drop it without touching state: the current card stays live and its own
    // controls still work, so the user is not punished for a platform retry.
    //
    // A callback carrying a NEWER generation is a different situation and must
    // NOT be refused. The card update is acknowledged by the platform, but an
    // acknowledgement can be lost; when that happens the entry has not committed
    // the newer generation while the user IS looking at the newer card. Refusing
    // it would make that card dead. So the entry adopts it.
    //
    // Callbacks are platform-signed, so the generation in the payload is
    // authenticated: a client cannot forge a newer card into existence, it can
    // only relay one the platform actually signed.
    if (parsed.renderGeneration !== undefined) {
      if (parsed.renderGeneration < entry.renderGeneration) {
        this.options.log?.("feishu.elicitation.stale_callback", "dropped a callback from an earlier card render", {
          requestId: entry.requestId,
          callbackGeneration: parsed.renderGeneration,
          currentGeneration: entry.renderGeneration,
        });
        return { handled: false, settled: false };
      }
      if (parsed.renderGeneration > entry.renderGeneration) {
        this.options.log?.("feishu.elicitation.generation_promoted", "adopted a newer card generation the update acknowledgement lost", {
          requestId: entry.requestId,
          callbackGeneration: parsed.renderGeneration,
          previousGeneration: entry.renderGeneration,
        });
        entry.renderGeneration = parsed.renderGeneration;
      }
    }

    switch (parsed.action) {
      case "start": {
        entry.currentField = entry.request.fields[0]?.key;
        if (entry.currentField === undefined) {
          // A zero-field form has nothing to ask, but it is NOT a dead end: M1
          // keeps `accept` + `content: null` precisely for this, so Start goes
          // straight to the review page where Submit is the only way to accept.
          this.markPendingRender(entry);
          await this.renderReview(entry);
          return { handled: true, settled: false };
        }
        // The card is already on screen — Feishu delivered it before `sendCard`
        // resolved — so a click here is real, but `renderCurrentField` has no
        // `cardId` to update yet. Recording that a render is owed lets
        // `requestElicitation` replay it the moment the id exists, instead of
        // acknowledging the click and leaving the user on the opening card.
        this.markPendingRender(entry);
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
        //
        // The field comes from the interaction's OWN position, never from
        // `entry.currentField`. Feishu retries card callbacks and users
        // double-tap, and the cursor advances as soon as the first Skip lands —
        // so a redelivery of the same old callback used to skip a DIFFERENT
        // field, and if that field already had an answer, `markSkipped` deleted
        // it. Naming the field makes the duplicate a no-op on the same field.
        //
        // Position alone is not sufficient, though: Skip MUTATES field state, so a
        // replay that arrives after the user has since Edited the same field
        // would delete the newer answer — `Skip -> Edit -> save staging ->
        // review -> replay(Skip)` submitted the field as omitted. The generation
        // fence above is what closes that, because the replayed Skip came from a
        // card the user has left.
        const named = parsed.fieldIndex !== undefined ? entry.request.fields[parsed.fieldIndex] : undefined;
        if (!named) return { handled: false, settled: false };
        if (named.required) return { handled: false, settled: false };
        markSkipped(entry, named.key);
        // Park on the named field so a stale interaction from an older card still
        // moves to the correct next question.
        entry.currentField = named.key;
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
        // Record WHICH settlement this was, before anything can observe it
        // missing. The send race needs it: a `sendCard` still in flight must not
        // read this settlement as an external abort and reject the user's turn.
        entry.decisionAction = parsed.action;
        entry.decision = decision;
        this.options.pending.delete(parsed.token);
        // SETTLE THE PROTOCOL FIRST, THEN RENDER.
        //
        // `withdraw` is a `card.update` network round trip. Holding the turn's
        // promise behind it means a CardKit request that never returns also never
        // delivers the decision: `pending` is already cleared so a retry finds no
        // entry, `done` never settles, and core can only time the turn out. The
        // same ordering Discord's paths already use — atomic protocol state, then
        // best-effort terminal UI.
        entry.resolve(decision);
        // The card must show what the user actually chose. `withdraw` used to
        // translate any "terminal" into "accepted", so declining rendered an
        // accepted card and cancelling rendered an accepted one too — the exact
        // opposite of the decision, while the protocol decision was correct.
        await this.withdraw(entry, parsed.action === "decline" ? "declined" : "cancelled");
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
    // Ask core's own question about the collected answers BEFORE the card is
    // withdrawn as "accepted". Core re-validates either way, but skipping this
    // meant the user reviewed, submitted, saw Accepted, and only then had the
    // broker cancel the turn for a typo — with no chance left to correct it.
    const rejected = findRejectedAnswer(entry.request.fields, entry.values);
    if (rejected) {
      const field = entry.request.fields.find((candidate) => candidate.key === rejected.key);
      if (field) {
        // Back to the offending field so the answer is editable again.
        entry.currentField = field.key;
        await this.renderCurrentField(entry);
        this.options.log?.("feishu.elicitation.answer_rejected", "answer does not satisfy its field constraints", {
          requestId: entry.requestId,
          fieldKey: field.key,
          reason: rejected.reason,
        });
      }
      return { handled: true, settled: false };
    }
    if (!trySettle(entry)) return { handled: false, settled: false };
    const content = buildElicitationContent(entry);
    const decision: ChannelElicitationDecision = {
      action: "accept",
      responderId: entry.requesterId,
      content,
    };
    // Record the settlement kind, for the same reason the decline path does.
    entry.decisionAction = "accept";
    entry.decision = decision;
    this.options.pending.delete(entry.token);
    // SETTLE THE PROTOCOL FIRST, THEN RENDER.
    //
    // `withdraw` is a `card.update` round trip; holding the turn's promise behind
    // it lets a hung CardKit request swallow a decision the user made. Core still
    // re-validates the answer, so settling first never bypasses validation — it
    // only stops a cosmetic network call from being able to lose a decision.
    entry.resolve(decision);
    // The user's OWN decision is what the terminal card must show. `withdraw`
    // used to hard-code "accepted", so a Decline or a Cancel rendered an
    // accepted card — the opposite of what the user just chose.
    await this.withdraw(entry, "accepted");
    return { handled: true, settled: true };
  }

  /**
   * Record that the wizard advanced but its render could not land yet.
   *
   * Set unconditionally by the advancing callbacks and cleared by whichever render
   * actually succeeds, so the flag means "owed" rather than "owed at the opening
   * send" — a later callback that renders fine resets it and the replay after the
   * send is then a no-op.
   */
  private markPendingRender(entry: PendingFeishuElicitation): void {
    entry.pendingRender = true;
  }

  /** Re-render the card for the current field, in place. */
  private async renderCurrentField(entry: PendingFeishuElicitation): Promise<void> {
    if (!entry.cardId || entry.settled) return;
    const key = entry.currentField;
    if (key === undefined) return;
    const field = entry.request.fields.find((f) => f.key === key);
    if (!field) return;
    // The generation this drawn card will carry, staged locally and committed to
    // the entry only once the update has actually LANDED.
    //
    // Committing before the send is the old behaviour and it is wrong in both
    // directions. The entry reports generation N+1 while the card on screen is
    // still generation N, so the user's next interaction with the very card they
    // are looking at arrives "stale" and is dropped — which turns a transient
    // CardKit failure into a form the user cannot submit. Conversely, if the
    // platform APPLIED the card but its acknowledgement was lost, the entry stays
    // on N and a signed callback from the applied card carries N+1; that is not
    // an old card but a newer one, and rejecting it on `<` would be wrong too.
    //
    // Staging handles both: a failed update leaves the entry and the screen in
    // agreement (both N), and a genuinely newer signed callback promotes the
    // entry's generation instead of being refused.
    const nextGeneration = entry.renderGeneration + 1;
    const card = buildElicitationFieldCard(
      entry.request,
      entry.token,
      field,
      entry.request.fields.indexOf(field) + 1,
      entry.values[field.key],
      nextGeneration,
    );
    try {
      await this.options.transport.updateCard({
        cardId: entry.cardId,
        sequence: nextSequence(entry),
        card,
      });
      // Only now is the drawn generation the one on screen.
      entry.renderGeneration = nextGeneration;
      // The render landed, so nothing is owed for this step.
      entry.pendingRender = false;
    } catch (error) {
      // A failed re-render is not a decision: the card stays live and the user
      // can retry, so the request is unsettled and Feishu's own retry applies.
      // The generation is deliberately NOT advanced — the card on screen is still
      // the previous one, and its controls must stay usable.
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
    // REJECT FIRST, THEN RENDER — the same ordering the user-decision paths use.
    //
    // An external withdrawal is not a user decision, so this rejects with no
    // responderId. It must also not sit behind a `card.update` round trip: the
    // channel's stop path awaits every drain, so one CardKit request that never
    // returns would hold the whole daemon shutdown open behind a cosmetic update.
    entry.reject(new Error(reason));
    await this.withdraw(entry, "cancelled");
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
      // The render landed, so nothing is owed for this step.
      entry.pendingRender = false;
    } catch (error) {
      this.options.log?.("feishu.elicitation.update_failed", "failed to render review card", {
        requestId: entry.requestId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
