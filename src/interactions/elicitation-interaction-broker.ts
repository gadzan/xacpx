/**
 * Core-owned ACP form-Elicitation broker (M1).
 *
 * Owns the interaction AFTER the trusted turn route is already resolved: it
 * consumes the exact opaque `interactionId` (never a session/chat/alias
 * lookup), renders through a channel plugin, re-verifies the authenticated
 * responder, validates the answer, and maps the result back to the three ACP
 * actions. Semantics are deliberately NOT shared with the permission broker
 * (roadmap G3): outcomes, deadlines and validation are Elicitation-specific.
 *
 * Fail-closed table (M1 plan §10):
 *
 *   accept            → explicit user accept (validated content)
 *   decline           → explicit user refusal ONLY
 *   cancel            → timeout / turn abort / shutdown / unsupported
 *                       channel / invalid schema / invalid answer /
 *                       plugin throw / stale race
 *
 * Privacy (G8): the broker logs metadata only — request id, field count,
 * field kinds, terminal action, duration. Form answers never reach logs,
 * state, diagnostics or traces.
 */

import { randomUUID } from "node:crypto";

import type {
  ChannelElicitationDecision,
  ChannelElicitationRequest,
  MessageChannelRuntime,
} from "../channels/types.js";
import type { AppLogger } from "../logging/app-logger.js";
import {
  normalizeAcpElicitationForm,
  summarizeElicitationSchema,
  validateElicitationAnswer,
  type NormalizedElicitationForm,
} from "./elicitation-schema.js";
import type {
  ChannelElicitationField,
  MessageChannelElicitationRuntime,
} from "./elicitation-types.js";
import {
  createTurnInteractionRegistry,
  type TurnInteractionContext,
  type TurnInteractionRegistry,
} from "./turn-interaction-registry.js";

/** Business deadline for a human answer. Core constant, not a config knob. */
export const ELICITATION_INTERACTION_TIMEOUT_MS = 120_000;

/** Transport watchdog must exceed the broker deadline. */
export const ELICITATION_RPC_TIMEOUT_MS = 125_000;

export type RuntimeElicitationRequest = {
  /** Owning Runtime prompt request (outer turn identity). */
  promptRequestId: string;
  /** Worker-assigned correlation id (randomUUID). */
  elicitationRequestId: string;
  /** Exact originating human turn, when the prompt carried one. */
  interactionId?: string;
  /** Raw ACP `elicitation/create` request at the core boundary. */
  request: unknown;
};

export type ElicitationResult =
  | {
      action: "accept";
      content: Record<string, string | number | boolean | string[]> | null;
    }
  | { action: "decline" }
  | { action: "cancel" };

export type ElicitationChannelResolver = (chatKey: string) => MessageChannelRuntime | null;

export interface ElicitationInteractionBrokerOptions {
  getChannelByChatKey: ElicitationChannelResolver;
  logger?: AppLogger;
  timeoutMs?: number;
  /** Shared exact-turn registry (permission + elicitation, independent semantics). */
  registry?: TurnInteractionRegistry;
}

interface PendingElicitation {
  interactionId: string;
  route: TurnInteractionContext;
  channelRequest: ChannelElicitationRequest;
  form: NormalizedElicitationForm;
  settled: boolean;
  controller: AbortController;
  timer?: ReturnType<typeof setTimeout>;
  startedAt: number;
}

/** Metadata-only log projection: never titles, never answers. */
interface ElicitationLogFields {
  fieldCount: number;
  fieldKinds: string;
  durationMs?: number;
  action?: string;
}

export class ElicitationInteractionBroker {
  private readonly turns: TurnInteractionRegistry;
  private readonly pending = new Map<string, PendingElicitation>();
  private readonly getChannelByChatKey: ElicitationChannelResolver;
  private readonly logger?: AppLogger;
  private readonly timeoutMs: number;
  private shutDown = false;

  constructor(options: ElicitationInteractionBrokerOptions) {
    this.turns = options.registry ?? createTurnInteractionRegistry();
    this.getChannelByChatKey = options.getChannelByChatKey;
    if (options.logger) this.logger = options.logger;
    this.timeoutMs = options.timeoutMs ?? ELICITATION_INTERACTION_TIMEOUT_MS;
  }

  /** Shared exact-turn registry (test/diagnostic use). */
  get turnRegistry(): TurnInteractionRegistry {
    return this.turns;
  }

  /**
   * Bind one exact human turn route. Called by the prompt dispatcher with
   * the SAME context the permission broker receives; the two brokers keep
   * separate pending sets and separate terminal semantics.
   */
  bindTurn(
    context: TurnInteractionContext,
    abortSignal?: AbortSignal,
  ): () => void {
    return this.turns.bindTurn(context, abortSignal);
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  /** Create a fresh opaque interaction id for one human prompt dispatch. */
  static createInteractionId(): string {
    return randomUUID();
  }

  /**
   * Resolve one ACP form Elicitation for the exact turn that caused it.
   * Every failure path maps to `cancel`; only an explicit platform-
   * authenticated refusal maps to `decline`.
   */
  async resolveElicitation(input: RuntimeElicitationRequest): Promise<ElicitationResult> {
    const requestId = input.elicitationRequestId;
    if (!requestId || this.shutDown) {
      await this.log("elicitation.interaction.rejected_unavailable", "broker unavailable", { requestId, fieldCount: 0, fieldKinds: "" });
      return { action: "cancel" };
    }
    if (this.pending.has(requestId)) {
      await this.log("elicitation.interaction.stale", "duplicate elicitation request id", { requestId, fieldCount: 0, fieldKinds: "" });
      return { action: "cancel" };
    }
    const interactionId = input.interactionId;
    const route = typeof interactionId === "string" ? this.turns.resolve(interactionId) : undefined;
    if (!interactionId || !route) {
      // Exact-turn ownership: no trusted route means no UI anywhere. Never
      // fall back to latest session / latest chat / latest user (G2).
      await this.log("elicitation.interaction.rejected_unavailable", "missing interaction route", { requestId, fieldCount: 0, fieldKinds: "" });
      return { action: "cancel" };
    }
    if (route.origin !== "human") {
      await this.log("elicitation.interaction.rejected_unavailable", "non-human origin is non-interactive", {
        requestId,
        origin: route.origin,
        fieldCount: 0,
        fieldKinds: "",
      });
      return { action: "cancel" };
    }
    if (!route.senderId) {
      await this.log("elicitation.interaction.rejected_unavailable", "missing initiator identity", { requestId, fieldCount: 0, fieldKinds: "" });
      return { action: "cancel" };
    }
    let channel: MessageChannelRuntime | null = null;
    try {
      channel = this.getChannelByChatKey(route.chatKey);
    } catch (error) {
      // Type only, and a FIXED classification: a resolver throwing an
      // agent-supplied chatKey into its message must not become a log line,
      // and `error.constructor.name` is itself renderer-controlled (G8).
      await this.log("elicitation.interaction.channel_failed", "channel lookup threw", {
        requestId,
        errorType: error instanceof Error ? "Error" : typeof error,
        fieldCount: 0,
        fieldKinds: "",
      });
      return { action: "cancel" };
    }
    const runtime = channel as MessageChannelElicitationRuntime | null;
    const declared = Array.isArray(runtime?.elicitationModes) ? runtime!.elicitationModes! : [];
    // G9 truthful capability: declare AND implement. A mode named without a
    // real handler is not support.
    const canRenderForm = declared.includes("form") && typeof runtime?.requestElicitation === "function";
    if (!runtime || !canRenderForm) {
      // G12: unsupported channels cancel — never consume the next arbitrary
      // human message as the answer.
      await this.log("elicitation.interaction.rejected_unavailable", "channel cannot render form elicitation", { requestId, fieldCount: 0, fieldKinds: "" });
      return { action: "cancel" };
    }
    const normalized = normalizeAcpElicitationForm(input.request);
    if (!normalized.ok) {
      await this.log("elicitation.interaction.invalid_schema", "acp form schema rejected", {
        requestId,
        reason: normalized.reason,
        fieldCount: 0,
        fieldKinds: "",
      });
      return { action: "cancel" };
    }
    // TWO copies of the same normalized form, deliberately:
    //
    //   validationSnapshot — private to core, never handed to a plugin. This
    //     is the ONLY truth used by validateElicitationAnswer below.
    //   presentation      — deep-cloned and deep-frozen, given to the renderer
    //     via channelRequest.fields.
    //
    // The public contract exposes `fields` as mutable arrays/objects, so a
    // renderer that reorganizes them for its UI would otherwise mutate core's
    // validation truth: pushing an extra option, clearing `required`, or
    // relaxing `minLength` would make an answer the agent never authorized
    // validate as legal. Freezing makes that fail loudly instead of silently.
    const validationSnapshot = cloneFormForValidation(normalized.form);
    const presentation = deepFreezeForm(cloneFormForValidation(normalized.form));
    const fields = validationSnapshot.fields;

    const controller = new AbortController();
    const startedAt = Date.now();
    const expiresAt = startedAt + this.timeoutMs;
    const pending: PendingElicitation = {
      interactionId,
      route,
      channelRequest: {
        requestId,
        chatKey: route.chatKey,
        ...(route.accountId !== undefined ? { accountId: route.accountId } : {}),
        ...(route.replyContextToken !== undefined ? { replyContextToken: route.replyContextToken } : {}),
        requester: {
          senderId: route.senderId,
          ...(route.senderName !== undefined ? { senderName: route.senderName } : {}),
          ...(route.isOwner !== undefined ? { isOwner: route.isOwner } : {}),
        },
        message: normalized.form.message,
        mode: "form",
        fields: presentation.fields,
        ...(normalized.form.schemaTitle !== undefined ? { schemaTitle: normalized.form.schemaTitle } : {}),
        ...(normalized.form.schemaDescription !== undefined ? { schemaDescription: normalized.form.schemaDescription } : {}),
        expiresAt,
        signal: controller.signal,
      },
      form: validationSnapshot,
      settled: false,
      controller,
      startedAt,
    };
    this.pending.set(requestId, pending);
    pending.timer = setTimeout(() => {
      // Terminal FIRST, then abort: a channel decision already resolving
      // must never win over the deadline in the race below (stale-race
      // fencing, same discipline as the permission broker).
      pending.settled = true;
      controller.abort();
    }, this.timeoutMs);
    if (typeof pending.timer.unref === "function") pending.timer.unref();

    // Subscribe to the shared registry: turn disposal or abort cancels this
    // request immediately, independent of the channel's own signal handling.
    const unsubscribeTurnAbort = this.turns.subscribeAbort(interactionId, () => {
      const current = this.pending.get(requestId);
      if (current !== pending || current.settled) return;
      current.settled = true;
      try {
        controller.abort();
      } catch {}
      if (current.timer !== undefined) {
        clearTimeout(current.timer);
        current.timer = undefined;
      }
    });

    await this.log("elicitation.interaction.dispatched", "elicitation interaction dispatched", {
      requestId,
      ...this.describe(fields),
    });

    const routeGone = (): boolean => this.turns.resolve(interactionId) !== route;
    if (pending.settled
      || this.pending.get(requestId) !== pending
      || controller.signal.aborted
      || Date.now() >= expiresAt
      || routeGone()
      || this.shutDown) {
      unsubscribeTurnAbort();
      return this.settleStale(requestId, fields, startedAt);
    }

    try {
      const aborted = new Promise<never>((_, reject) => {
        if (controller.signal.aborted) {
          reject(new Error("elicitation interaction aborted"));
          return;
        }
        controller.signal.addEventListener(
          "abort",
          () => reject(new Error("elicitation interaction aborted")),
          { once: true },
        );
      });
      // Race so a channel that ignores AbortSignal still settles on
      // timeout/turn-dispose/shutdown instead of leaking pending state.
      const decision = (await Promise.race([
        runtime.requestElicitation!(pending.channelRequest),
        aborted,
      ])) as ChannelElicitationDecision | undefined;

      // Post-decision re-verification: the settled flag, wall clock and
      // route liveness win over whatever the channel returned — a stale
      // answer must never survive the race.
      if (pending.settled
        || this.pending.get(requestId) !== pending
        || controller.signal.aborted
        || Date.now() >= expiresAt
        || routeGone()
        || this.shutDown) {
        unsubscribeTurnAbort();
        return this.settleStale(requestId, fields, startedAt);
      }

      // Platform-authenticated identity: a wrong responder is never
      // accepted, and never becomes `decline` either (fail closed cancel).
      if (!decision || typeof decision.responderId !== "string" || decision.responderId !== route.senderId) {
        await this.log("elicitation.interaction.channel_failed", "responder is not the turn initiator", {
          requestId,
          ...this.describe(fields),
        });
        unsubscribeTurnAbort();
        return this.settleStale(requestId, fields, startedAt);
      }

      if (decision.action !== "accept") {
        // decline and cancel are both terminal; only decline is a user
        // refusal. Every failure path reaches here as cancel.
        const result: ElicitationResult = decision.action === "decline"
          ? { action: "decline" }
          : { action: "cancel" };
        unsubscribeTurnAbort();
        return this.commit(requestId, result, fields, startedAt);
      }

      // accept: core re-validates the content against the normalized schema.
      const validated = validateElicitationAnswer(fields, decision.content);
      if (!validated.ok) {
        await this.log("elicitation.interaction.invalid_answer", "accepted elicitation answer failed validation", {
          requestId,
          reason: validated.reason,
          ...this.describe(fields),
        });
        unsubscribeTurnAbort();
        return this.settleStale(requestId, fields, startedAt);
      }
      const content = decision.content === null ? null : validated.content;
      unsubscribeTurnAbort();
      return this.commit(requestId, { action: "accept", content }, fields, startedAt);
    } catch (error) {
      // Plugin throw, explicit cancel, abort, timeout: all cancel. Only a
      // FIXED classification is recorded — `error.constructor.name` is
      // renderer-controlled (an overriding `constructor` property, or a
      // throwing getter, both attacker-reachable), so reading it would let a
      // renderer put submitted form values into the log (G8).
      if (controller.signal.aborted) {
        await this.log("elicitation.interaction.aborted", "elicitation interaction aborted before decision", {
          requestId,
        });
      } else {
        await this.log("elicitation.interaction.channel_failed", "channel request failed", {
          requestId,
          errorType: error instanceof Error ? "Error" : typeof error,
        });
      }
      unsubscribeTurnAbort();
      return this.settleStale(requestId, fields, startedAt);
    } finally {
      if (pending.timer !== undefined) {
        clearTimeout(pending.timer);
        pending.timer = undefined;
      }
    }
  }

  /** Abort every pending request of one interaction (turn completion/cancel). */
  abortInteraction(interactionId: string, reason = "turn_disposed"): void {
    for (const [requestId, pending] of [...this.pending]) {
      if (pending.interactionId !== interactionId || pending.settled) continue;
      pending.settled = true;
      try {
        pending.controller.abort();
      } catch {}
      if (pending.timer !== undefined) {
        clearTimeout(pending.timer);
        pending.timer = undefined;
      }
      void this.log("elicitation.interaction.aborted", "elicitation interaction aborted", {
        requestId,
        reason,
        ...this.describe(pending.form.fields),
      });
    }
  }

  shutdown(): void {
    if (this.shutDown) return;
    this.shutDown = true;
    for (const pending of this.pending.values()) {
      if (pending.settled) continue;
      pending.settled = true;
      try {
        pending.controller.abort();
      } catch {}
      if (pending.timer !== undefined) {
        clearTimeout(pending.timer);
        pending.timer = undefined;
      }
    }
    this.turns.clear();
    // Pending entries stay until their races settle so a late channel answer
    // fails closed; new requests fail closed via the shutDown flag.
  }

  /**
   * A stale/expired/aborted entry resolves to cancel. First-terminal-wins is
   * enforced by `settled` + the pending-map identity check inside commit().
   */
  private async settleStale(
    requestId: string,
    fields: NormalizedElicitationForm["fields"],
    startedAt: number,
  ): Promise<ElicitationResult> {
    await this.log("elicitation.interaction.expired", "elicitation interaction settled as cancel", {
      requestId,
      ...this.describe(fields),
      durationMs: Date.now() - startedAt,
    });
    return this.commit(requestId, { action: "cancel" }, fields, startedAt, true);
  }

  /** Commit the terminal decision (idempotent, first terminal wins). */
  private commit(
    requestId: string,
    result: ElicitationResult,
    fields: NormalizedElicitationForm["fields"],
    startedAt: number,
    alreadyLogged = false,
  ): ElicitationResult {
    const pending = this.pending.get(requestId);
    if (pending) {
      if (pending.settled && result.action !== "cancel") {
        // A fail-closed terminal already committed; keep it.
        this.pending.delete(requestId);
        return { action: "cancel" };
      }
      pending.settled = true;
      if (pending.timer !== undefined) {
        clearTimeout(pending.timer);
        pending.timer = undefined;
      }
      this.pending.delete(requestId);
    }
    if (!alreadyLogged) {
      // Metadata only — never answers (G8).
      void this.log("elicitation.interaction.resolved", "elicitation interaction resolved", {
        requestId,
        action: result.action,
        ...this.describe(fields),
        durationMs: Date.now() - startedAt,
      });
    }
    return result;
  }

  private describe(fields: NormalizedElicitationForm["fields"]): Omit<ElicitationLogFields, "action"> {
    const summary = summarizeElicitationSchema(fields);
    return { fieldCount: summary.fieldCount, fieldKinds: summary.kinds.join(",") };
  }

  private async log(
    event: string,
    message: string,
    fields: Record<string, string | number | boolean | undefined>,
  ): Promise<void> {
    try {
      await this.logger?.info(event, message, fields);
    } catch {}
  }
}

/**
 * Deep clone of the normalized form. Core keeps one private copy as its
 * validation truth and hands a separate clone to the renderer, so nothing a
 * plugin does to `request.fields` can change what core validates against.
 */
function cloneFormForValidation(form: NormalizedElicitationForm): NormalizedElicitationForm {
  return {
    ...(form.schemaTitle !== undefined ? { schemaTitle: form.schemaTitle } : {}),
    ...(form.schemaDescription !== undefined ? { schemaDescription: form.schemaDescription } : {}),
    message: form.message,
    fields: form.fields.map((field): ChannelElicitationField => {
      switch (field.kind) {
        case "single-select":
          return {
            ...field,
            options: field.options.map((option) => ({ ...option })),
            ...(field.defaultValue !== undefined ? { defaultValue: field.defaultValue } : {}),
          };
        case "multi-select":
          return {
            ...field,
            options: field.options.map((option) => ({ ...option })),
            ...(field.defaultValue !== undefined ? { defaultValue: [...field.defaultValue] } : {}),
          };
        default:
          return { ...field };
      }
    }),
  };
}

/** Recursively freeze the presentation copy so mutation throws in strict mode. */
function deepFreezeForm(form: NormalizedElicitationForm): NormalizedElicitationForm {
  for (const field of form.fields) {
    Object.freeze(field);
    if (field.kind === "single-select" || field.kind === "multi-select") {
      for (const option of field.options) Object.freeze(option);
      Object.freeze(field.options);
      if (field.defaultValue !== undefined && Array.isArray(field.defaultValue)) {
        Object.freeze(field.defaultValue);
      }
    }
  }
  Object.freeze(form.fields);
  return Object.freeze(form);
}

let globalBroker: ElicitationInteractionBroker | null = null;

export function setGlobalElicitationBroker(broker: ElicitationInteractionBroker | null): void {
  globalBroker = broker;
}

export function getGlobalElicitationBroker(): ElicitationInteractionBroker | null {
  return globalBroker;
}

export function resetGlobalElicitationBrokerForTests(): void {
  try {
    globalBroker?.shutdown();
  } catch {}
  globalBroker = null;
}
