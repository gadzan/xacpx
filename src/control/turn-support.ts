import type { ChatRequestMetadata } from "../weixin/agent/interface";
import type { PromptAttachmentRef } from "@ganglion/xacpx-relay-protocol";

/** A prompt held in the per-session server-side queue while a turn is in flight.
 *  Runs through the same `executeTurn` machinery as a manual prompt once drained. */
export interface QueuedPrompt {
  id: string;
  text: string;
  enqueuedAt: string;
  senderId: string;
  isOwner?: boolean;
  accountId?: string;
  media?: PromptAttachmentRef[];
}

// Upper bound on how long a follow-up prompt waits for a just-cancelled turn to
// finish tearing down before giving up and reporting the session still busy.
export const CANCEL_DRAIN_TIMEOUT_MS = 5000;

// Server-side truncation for a queued item's textPreview on the queue-updated wire
// event, so a very long queued prompt doesn't bloat the snapshot payload.
export const QUEUE_PREVIEW_MAX = 120;

// Resolve when `promise` settles or `ms` elapses, whichever comes first. The timer
// is cleared on the winning path so a fast drain doesn't keep the event loop alive.
export async function raceWithTimeout(promise: Promise<void>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
  });
  try {
    await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// Abort reason a turn's watchdog uses (via controller.abort(TURN_IDLE_TIMEOUT)) to mark
// an inactivity-timeout abort, so SessionTurnRunner can surface it distinctly from a user
// Stop (which aborts with no reason). Read via signal.reason in the runner's catch.
export const TURN_IDLE_TIMEOUT = Symbol("turn-idle-timeout");

export function turnKey(chatKey: string, sessionAlias: string): string {
  return `${chatKey} ${sessionAlias}`;
}

export function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function buildControlMetadata(senderId: string, isOwner: boolean | undefined): ChatRequestMetadata {
  return {
    channel: "control",
    chatType: "direct",
    senderId,
    ...(isOwner === undefined ? {} : { isOwner }),
  };
}
