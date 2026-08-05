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
  /** Hub-issued pre-write correlation (see PromptPayload.promptRequestId); carried
   *  onto the drained turn-started so the hub can tie the queue item back to the
   *  pre-written inbound row even if the queued RPC response was lost. */
  promptRequestId?: string;
}

// Upper bound on how long a follow-up prompt waits for a just-cancelled turn to
// finish tearing down before giving up and reporting the session still busy.
export const CANCEL_DRAIN_TIMEOUT_MS = 5000;

// Server-side truncation for a queued item's textPreview on the queue-updated wire
// event, so a very long queued prompt doesn't bloat the snapshot payload.
export const QUEUE_PREVIEW_MAX = 120;

// Upper bound on queued prompts per session. The queue is unbounded connector memory
// otherwise — a client spamming prompts mid-turn would grow it without limit.
export const QUEUE_MAX_DEPTH = 20;

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

// Abort reason a turn's watchdog uses (via controller.abort(TURN_IDLE_TIMEOUT_REASON)) to
// mark an inactivity-timeout abort, so SessionTurnRunner can surface it distinctly from a user
// Stop (which aborts with no reason). Read via signal.reason in the runner's catch. It is an
// abort-REASON sentinel, not a duration — the threshold in ms lives in config/TurnQueue.
export const TURN_IDLE_TIMEOUT_REASON = Symbol("turn-idle-timeout");

/** Detail handed to the idle-timeout observability hook when the inactivity watchdog reclaims a
 *  wedged turn: the session it fired for and the concrete threshold (ms) that tripped. Shared by
 *  TurnQueue's `onIdleTimeout` seam and ControlService's `onTurnIdleTimeout` passthrough. */
export interface TurnIdleTimeoutDetail {
  chatKey: string;
  sessionAlias: string;
  idleMs: number;
}

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
