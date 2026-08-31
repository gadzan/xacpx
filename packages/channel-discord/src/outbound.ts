import type { DeliveryTarget, OutboundBody } from "./types.js";
import type { DiscordClientLike } from "./discord-client.js";
import { isDiscordArchivedThreadError, isDiscordNotFoundError } from "./errors.js";
import { chunkDiscordText } from "./chunk.js";
import { renderDiscordMarkdown } from "./markdown.js";
import type { DiscordTableMode } from "./types.js";

export interface SendRouteTextInput {
  chatKey: string;
  text: string;
  tableMode: DiscordTableMode;
  maxChars?: number;
  maxLines?: number;
  parseChatKey: (chatKey: string) => DeliveryTarget | null;
  sendMessage: (target: DeliveryTarget, body: OutboundBody) => Promise<void>;
}

export async function sendRouteText(input: SendRouteTextInput): Promise<void> {
  const target = input.parseChatKey(input.chatKey);
  if (!target) throw new Error(`cannot deliver Discord message to non-Discord chatKey: ${input.chatKey}`);
  const rendered = renderDiscordMarkdown(input.text, input.tableMode);
  const chunks = chunkDiscordText(rendered, { maxChars: input.maxChars ?? 2000, maxLines: input.maxLines ?? 17 });
  for (const chunk of chunks) {
    try {
      await input.sendMessage(target, { content: chunk, allowedMentions: { parse: [] } });
    } catch (error) {
      // If thread was archived and send fails, try parent.
      // Caller can provide fallback logic; for now we just rethrow and let channel handle it.
      throw error;
    }
  }
}

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
