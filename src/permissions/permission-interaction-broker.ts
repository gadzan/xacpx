import { randomUUID } from "node:crypto";

import type {
  ChannelPermissionDecision,
  ChannelPermissionRequest,
  MessageChannelRuntime,
} from "../channels/types.js";
import type { AppLogger } from "../logging/app-logger.js";
import { summarizePermissionRequest } from "./permission-summary.js";
import {
  isPermissionOutcome,
  type PermissionOutcome,
  type RuntimePermissionInteractionRequest,
  type TurnInteractionContext,
} from "./permission-types.js";

export type { TurnInteractionContext } from "./permission-types.js";

/** Business deadline for a human decision. Core constant, not a config knob (plan §15.5). */
export const PERMISSION_INTERACTION_TIMEOUT_MS = 120_000;

/** Transport watchdog must exceed the broker deadline (plan §7.4). */
export const PERMISSION_RPC_TIMEOUT_MS = 125_000;

export type PermissionChannelResolver = (chatKey: string) => MessageChannelRuntime | null;

export interface PermissionInteractionBrokerOptions {
  getChannelByChatKey: PermissionChannelResolver;
  logger?: AppLogger;
  timeoutMs?: number;
}

interface PendingPermission {
  interactionId: string;
  settled: boolean;
  controller: AbortController;
  timer?: ReturnType<typeof setTimeout>;
}

function validOutcomes(input: unknown): PermissionOutcome[] {
  if (!Array.isArray(input)) return [];
  const out: PermissionOutcome[] = [];
  for (const item of input) {
    if (isPermissionOutcome(item) && !out.includes(item)) out.push(item);
  }
  return out;
}

/**
 * Core-owned exact-turn permission router (plan §7).
 *
 * - Routes by opaque interactionId, never by session-level latest-chat state.
 * - First terminal decision wins; every error path fails closed to reject_once.
 * - Pending state is memory-only; shutdown invalidates everything.
 */
export class PermissionInteractionBroker {
  private readonly turns = new Map<string, TurnInteractionContext>();
  private readonly pending = new Map<string, PendingPermission>();
  private readonly getChannelByChatKey: PermissionChannelResolver;
  private readonly logger?: AppLogger;
  private readonly timeoutMs: number;
  private shutDown = false;

  constructor(options: PermissionInteractionBrokerOptions) {
    this.getChannelByChatKey = options.getChannelByChatKey;
    if (options.logger) this.logger = options.logger;
    this.timeoutMs = options.timeoutMs ?? PERMISSION_INTERACTION_TIMEOUT_MS;
  }

  /**
   * Register the exact turn route before prompt dispatch. The returned
   * disposer removes ONLY the binding it created and aborts that turn's
   * pending permission requests. When the owning turn's AbortSignal is
   * provided, the broker subscribes directly: a /cancel or Stop aborts every
   * pending request for this interaction immediately, without waiting for a
   * slow transport.cancel() to settle the prompt (T3). The worker side is
   * already fail-closed on its own abort (it drops its pending entry and
   * returns reject_once), so no extra worker→host cancel event is needed —
   * both ends fail closed independently off the same turn abort.
   */
  bindTurn(context: TurnInteractionContext, abortSignal?: AbortSignal): () => void {
    if (this.turns.has(context.interactionId)) {
      throw new Error(`duplicate permission interaction binding: ${context.interactionId}`);
    }
    this.turns.set(context.interactionId, context);
    let disposed = false;
    const dispose = (): void => {
      if (disposed) return;
      disposed = true;
      abortSignal?.removeEventListener("abort", onAbort);
      const current = this.turns.get(context.interactionId);
      if (current !== context) return;
      this.turns.delete(context.interactionId);
      this.abortInteraction(context.interactionId, "turn_disposed");
    };
    const onAbort = (): void => {
      this.abortInteraction(context.interactionId, "turn_aborted");
    };
    if (abortSignal) {
      if (abortSignal.aborted) {
        onAbort();
      } else {
        abortSignal.addEventListener("abort", onAbort, { once: true });
      }
    }
    return dispose;
  }

  /** Create a fresh opaque interaction id for one human prompt dispatch. */
  static createInteractionId(): string {
    return randomUUID();
  }

  get boundTurnCount(): number {
    return this.turns.size;
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  async requestPermission(
    input: RuntimePermissionInteractionRequest,
  ): Promise<{ outcome: PermissionOutcome }> {
    const requestId = input.requestId;
    if (!requestId || this.shutDown) {
      return { outcome: "reject_once" };
    }
    if (this.pending.has(requestId)) {
      await this.log("permission.interaction.stale", "duplicate permission request id", {
        requestId,
      });
      return { outcome: "reject_once" };
    }
    const interactionId = input.interactionId;
    const route = typeof interactionId === "string" ? this.turns.get(interactionId) : undefined;
    if (!interactionId || !route) {
      await this.log("permission.interaction.rejected_unavailable", "missing interaction route", {
        requestId,
      });
      return { outcome: "reject_once" };
    }
    if (route.origin !== "human") {
      await this.log("permission.interaction.rejected_unavailable", "non-human origin is non-interactive", {
        requestId,
        origin: route.origin,
      });
      return { outcome: "reject_once" };
    }
    if (!route.senderId) {
      await this.log("permission.interaction.rejected_unavailable", "missing initiator identity", {
        requestId,
      });
      return { outcome: "reject_once" };
    }
    let channel: MessageChannelRuntime | null = null;
    try {
      channel = this.getChannelByChatKey(route.chatKey);
    } catch (error) {
      await this.log("permission.interaction.channel_failed", "channel lookup threw", {
        requestId,
        message: error instanceof Error ? error.message : String(error),
      });
      return { outcome: "reject_once" };
    }
    if (!channel || typeof channel.requestPermission !== "function") {
      await this.log("permission.interaction.rejected_unavailable", "channel does not support permission UI", {
        requestId,
      });
      return { outcome: "reject_once" };
    }

    const available = validOutcomes(input.availableOutcomes);
    const availableOutcomes: PermissionOutcome[] =
      available.length > 0 ? available : ["allow_once", "reject_once"];
    const presented = summarizePermissionRequest({
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.kind !== undefined ? { kind: input.kind } : {}),
      ...(input.rawInput !== undefined ? { rawInput: input.rawInput } : {}),
    });

    const controller = new AbortController();
    const pending: PendingPermission = { interactionId, settled: false, controller };
    this.pending.set(requestId, pending);
    const expiresAt = Date.now() + this.timeoutMs;
    pending.timer = setTimeout(() => {
      controller.abort();
    }, this.timeoutMs);
    if (typeof pending.timer.unref === "function") pending.timer.unref();

    await this.log("permission.interaction.requested", "permission interaction requested", {
      requestId,
      toolKind: input.kind ?? "",
    });

    const channelRequest: ChannelPermissionRequest = {
      requestId,
      chatKey: route.chatKey,
      ...(route.accountId !== undefined ? { accountId: route.accountId } : {}),
      ...(route.replyContextToken !== undefined
        ? { replyContextToken: route.replyContextToken }
        : {}),
      requester: {
        senderId: route.senderId,
        ...(route.senderName !== undefined ? { senderName: route.senderName } : {}),
        ...(route.isOwner !== undefined ? { isOwner: route.isOwner } : {}),
      },
      toolCallId: input.toolCallId,
      ...(presented.title !== undefined ? { title: presented.title } : {}),
      ...(presented.kind !== undefined ? { kind: presented.kind } : {}),
      ...(presented.summary !== undefined ? { summary: presented.summary } : {}),
      availableOutcomes,
      expiresAt,
      signal: controller.signal,
    };

    await this.log("permission.interaction.dispatched", "permission interaction dispatched", {
      requestId,
    });

    try {
      const aborted = new Promise<never>((_, reject) => {
        if (controller.signal.aborted) {
          reject(new Error("permission interaction aborted"));
          return;
        }
        controller.signal.addEventListener(
          "abort",
          () => reject(new Error("permission interaction aborted")),
          { once: true },
        );
      });
      // Race so a channel that ignores AbortSignal still settles on
      // timeout/turn-dispose/shutdown instead of leaking the pending entry.
      const decision = (await Promise.race([
        channel.requestPermission(channelRequest),
        aborted,
      ])) as ChannelPermissionDecision | undefined;
      const outcome = decision?.outcome;
      if (!isPermissionOutcome(outcome) || !availableOutcomes.includes(outcome)) {
        await this.log("permission.interaction.channel_failed", "malformed channel decision", {
          requestId,
        });
        return this.settle(requestId, { outcome: "reject_once" });
      }
      // I3 core re-verification: the channel must report WHO clicked, and it
      // must be the bound initiator. No silent trust in plugin-side checks.
      const responderId = decision?.responderId;
      if (typeof responderId !== "string" || responderId !== route.senderId) {
        await this.log("permission.interaction.channel_failed", "responder is not the turn initiator", {
          requestId,
        });
        return this.settle(requestId, { outcome: "reject_once" });
      }
      // A late decision after turn unbind/shutdown cannot become allow.
      if (!this.turns.has(interactionId) || this.shutDown) {
        await this.log("permission.interaction.stale", "decision arrived after turn ended", {
          requestId,
        });
        return this.settle(requestId, { outcome: "reject_once" });
      }
      await this.log("permission.interaction.resolved", "permission interaction resolved", {
        requestId,
        outcome,
      });
      return this.settle(requestId, { outcome });
    } catch (error) {
      if (controller.signal.aborted) {
        const reason = !this.turns.has(interactionId)
          ? "aborted"
          : this.shutDown
            ? "aborted"
            : Date.now() >= expiresAt
              ? "expired"
              : "aborted";
        await this.log(
          reason === "expired"
            ? "permission.interaction.expired"
            : "permission.interaction.aborted",
          reason === "expired" ? "permission interaction expired" : "permission interaction aborted",
          { requestId, reason },
        );
        return this.settle(requestId, { outcome: "reject_once" });
      }
      await this.log("permission.interaction.channel_failed", "channel request failed", {
        requestId,
        message: error instanceof Error ? error.message : String(error),
      });
      return this.settle(requestId, { outcome: "reject_once" });
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
      void this.log("permission.interaction.aborted", "permission interaction aborted", {
        requestId,
        reason,
      });
    }
    // Do NOT delete here: the in-flight requestPermission race still needs
    // the settled marker so a late channel allow fails closed in settle().
    // settle() removes the entry when the race resolves.
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
    // Pending entries stay until their races settle so late allows fail
    // closed; new requests fail closed via the shutDown flag.
  }

  private settle(
    requestId: string,
    result: { outcome: PermissionOutcome },
  ): { outcome: PermissionOutcome } {
    const pending = this.pending.get(requestId);
    if (pending) {
      if (pending.settled && result.outcome !== "reject_once") {
        // First terminal decision already committed as fail-closed; keep it.
        this.pending.delete(requestId);
        return { outcome: "reject_once" };
      }
      pending.settled = true;
      if (pending.timer !== undefined) {
        clearTimeout(pending.timer);
        pending.timer = undefined;
      }
      this.pending.delete(requestId);
    }
    return result;
  }

  private async log(event: string, message: string, fields: Record<string, string | number | boolean | undefined>): Promise<void> {
    try {
      await this.logger?.info(event, message, fields);
    } catch {}
  }
}

let globalBroker: PermissionInteractionBroker | null = null;

export function setGlobalPermissionBroker(broker: PermissionInteractionBroker | null): void {
  globalBroker = broker;
}

export function getGlobalPermissionBroker(): PermissionInteractionBroker | null {
  return globalBroker;
}

export function resetGlobalPermissionBrokerForTests(): void {
  try {
    globalBroker?.shutdown();
  } catch {}
  globalBroker = null;
}
