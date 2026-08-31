import type { DeliveryTarget, OutboundBody } from "./types.js";
import type { DiscordClientLike } from "./discord-client.js";
import { isDiscordArchivedThreadError, isDiscordNotFoundError } from "./errors.js";

export interface SendReplyWithGuardInput {
  client: DiscordClientLike;
  target: DeliveryTarget;
  /**
   * Resolves the parent channel to fall back to, and is only ever called after
   * the send to `target` failed as archived or missing. Lazy because a healthy
   * thread must not pay for a lookup it will never use, and because this helper
   * is the one place that owns the "send to the thread, else the parent"
   * decision: callers hand it the body and the resolver, never a pre-sent copy.
   */
  resolveParentTarget?: () => Promise<DeliveryTarget | null>;
  body: OutboundBody;
  loggerWarn?: (msg: string, fields?: Record<string, string | number | boolean | undefined>) => void;
}

export async function sendWithThreadFallback(input: SendReplyWithGuardInput): Promise<void> {
  try {
    await input.client.sendMessage(input.target, input.body);
  } catch (error) {
    if (!isDiscordArchivedThreadError(error) && !isDiscordNotFoundError(error)) throw error;
    // A resolver that itself fails must not replace the Discord error the
    // caller needs to see, so its own failure is swallowed and treated as
    // "no parent known".
    const parentTarget = input.resolveParentTarget
      ? await input.resolveParentTarget().catch(() => null)
      : null;
    if (!parentTarget) throw error;
    try {
      await input.client.sendMessage(parentTarget, input.body);
    } catch {
      throw error;
    }
    input.loggerWarn?.("discord.thread_fallback", { from: input.target.channelId, to: parentTarget.channelId });
  }
}
