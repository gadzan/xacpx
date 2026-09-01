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
  let closed = false;
  let op: Promise<void> | null = null;

  const flush = async (): Promise<void> => {
    if (closed || overflow) return;
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
      const thisOp = (async (): Promise<void> => {
        try {
          const sent = await client.sendMessage(target, { content: text, allowedMentions: { parse: [] } });
          sentId = sent.messageId;
        } catch (error) {
          createError = error;
        }
      })();
      op = thisOp;
      try {
        await thisOp;
      } finally {
        creating = false;
        if (op === thisOp) op = null;
      }
      if (closed) {
        if (sentId) messageId = sentId;
        return;
      }
      if (createError) {
        options.onWarn?.(`discord.preview.create_failed: ${createError instanceof Error ? createError.message : String(createError)}`);
        overflow = true;
        return;
      }
      messageId = sentId!;
      if (pendingText !== null && !closed && !overflow) {
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
    let editError: unknown = null;
    const thisEditOp = (async (): Promise<void> => {
      try {
        await client.editMessage(target, messageId!, { content: text, allowedMentions: { parse: [] } });
      } catch (error) {
        editError = error;
      }
    })();
    op = thisEditOp;
    try {
      await thisEditOp;
    } finally {
      editing = false;
      if (op === thisEditOp) op = null;
    }
    if (closed) return;
    if (editError) {
      options.onWarn?.(`discord.preview.edit_failed: ${editError instanceof Error ? editError.message : String(editError)}`);
      overflow = true;
      return;
    }
    if (pendingText !== null && !overflow && !closed) schedule();
  };

  const schedule = (): void => {
    if (closed || timer) return;
    timer = setTimeout(() => {
      timer = null;
      void flush();
    }, throttleMs);
  };

  return {
    update(text: string): void {
      if (closed || overflow) return;
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
      closed = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      pendingText = null;
      overflow = false;
      if (op) {
        try {
          await op;
        } catch {
          // ignore — error already handled in flush
        }
      }
      const toDelete = messageId;
      messageId = null;
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
