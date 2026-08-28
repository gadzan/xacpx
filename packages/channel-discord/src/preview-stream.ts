import type { DeliveryTarget } from "./types.js";
import type { DiscordClientLike } from "./discord-client.js";

export interface DiscordPreviewStreamOptions {
  client: DiscordClientLike;
  target: DeliveryTarget;
  maxChars?: number; // default 2000
  throttleMs?: number; // default 1200, min 250
  minInitialChars?: number; // default 200
  onWarn?: (msg: string) => void;
}

export interface DiscordPreviewStream {
  update(text: string): void;
  cleanup(): Promise<void>;
  created(): boolean;
}

export function createDiscordPreviewStream(options: DiscordPreviewStreamOptions): DiscordPreviewStream {
  const maxChars = options.maxChars ?? 2000;
  const throttleMs = Math.max(250, options.throttleMs ?? 1200);
  const minInitialChars = options.minInitialChars ?? 200;
  const client = options.client;
  const target = options.target;

  let messageId: string | null = null;
  let pendingText: string | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let overflow = false;
  let creating = false;
  let editing = false;

  const flush = async (): Promise<void> => {
    if (overflow) return;
    if (pendingText === null) return;
    if (creating || editing) return;
    const text = pendingText;
    pendingText = null;
    if (text.length > maxChars) {
      overflow = true;
      return;
    }

    if (messageId === null) {
      if (text.length < minInitialChars) {
        pendingText = text;
        return;
      }
      creating = true;
      let sentId: string | null = null;
      let createError: unknown = null;
      try {
        const sent = await client.sendMessage(target, { content: text, allowedMentions: { parse: [] } });
        sentId = sent.messageId;
      } catch (error) {
        createError = error;
      }
      creating = false;
      if (createError) {
        options.onWarn?.(`discord.preview.create_failed: ${createError instanceof Error ? createError.message : String(createError)}`);
        overflow = true;
        return;
      }
      messageId = sentId!;
      if (pendingText !== null) {
        const pending: string = pendingText;
        pendingText = null;
        if (pending.length <= maxChars) {
          pendingText = pending;
          void flush();
        } else {
          overflow = true;
        }
      }
      return;
    }

    editing = true;
    try {
      await client.editMessage(target, messageId, { content: text, allowedMentions: { parse: [] } });
    } catch (error) {
      options.onWarn?.(`discord.preview.edit_failed: ${error instanceof Error ? error.message : String(error)}`);
      overflow = true;
    } finally {
      editing = false;
      if (pendingText !== null && !overflow) schedule();
    }
  };

  const schedule = (): void => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      void flush();
    }, throttleMs);
  };

  return {
    update(text: string): void {
      if (overflow) return;
      if (text.length > maxChars) {
        overflow = true;
        return;
      }
      pendingText = text;
      if (messageId === null && text.length < minInitialChars) return;
      if (timer || creating || editing) return;
      schedule();
    },

    async cleanup(): Promise<void> {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      const toDelete = messageId;
      messageId = null;
      pendingText = null;
      overflow = false;
      if (toDelete !== null) {
        try {
          await client.deleteMessage(target, toDelete);
        } catch (error) {
          options.onWarn?.(`discord.preview.delete_failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    },

    created(): boolean {
      return messageId !== null;
    },
  };
}
