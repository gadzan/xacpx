/**
 * Peer delegation (prototype): session-to-session task delegation that runs
 * ALONGSIDE the coordinator-routed orchestration dispatch, never through it.
 *
 * A peer request is a delegation from one logical session to another:
 * - it is created in `needs_confirmation` and NEVER executes until an
 *   explicit `peer_approve` call (the operator authorization step);
 * - execution prompts the target session via the transport prompt path,
 *   which queues behind the target's active turn — it never cancels or
 *   interrupts what the target is doing;
 * - completion only fills the originator's record; the originator must
 *   validate the result (`peer_confirm`) before the delegation counts as
 *   delivered. Completion is a numbered terminal state, not proof the
 *   deliverable is correct.
 *
 * Message exchange between peers is NOT part of this module: it reuses the
 * existing agent_send one-way message path (delivery ACK + replyTo).
 * Do not build a second message channel here.
 */

export type PeerRequestStatus =
  | "needs_confirmation"
  | "running"
  | "completed"
  | "failed"
  | "delivered"
  | "cancelled";

/** Logical session identity. `alias` is the session alias; `workspace` is
 *  recorded when known and verified against resolution when provided. */
export interface PeerSessionIdentity {
  alias: string;
  workspace?: string;
}

export interface PeerRequest {
  requestId: string;
  originator: PeerSessionIdentity;
  target: PeerSessionIdentity;
  /**
   * Transport session name resolved from state at execution time.
   * Never hand-built: transport names may carry suffixes (e.g. `:reset-…`),
   * so this is always copied from the resolved session, never composed
   * from workspace + alias.
   */
  targetTransportSession?: string;
  task: string;
  status: PeerRequestStatus;
  /** Bounded final result text (16 KiB, same bound as peer completions). */
  result?: string;
  resultTruncated?: boolean;
  error?: string;
  createdAt: string;
  updatedAt: string;
  approvedAt?: string;
  approvedBy?: string;
  startedAt?: string;
  completedAt?: string;
  deliveredAt?: string;
  cancelledAt?: string;
}

export type PeerRequestTerminalStatus = Extract<
  PeerRequestStatus,
  "completed" | "failed" | "delivered" | "cancelled"
>;

export function isPeerRequestTerminal(
  status: PeerRequestStatus,
): status is PeerRequestTerminalStatus {
  return (
    status === "completed" ||
    status === "failed" ||
    status === "delivered" ||
    status === "cancelled"
  );
}

export interface PeerWatchResult {
  /** `terminal`: the request reached a terminal status. `timeout`: only the
   *  watch ended — the request keeps running; a timeout is never a failure
   *  and never a reason to resend. */
  status: "terminal" | "timeout";
  request: PeerRequest;
}

/**
 * Actionable error text used whenever peer tools have no bound transport.
 * It states the cause (Daemon RPC binding is not part of this prototype)
 * and points at the doc, instead of internal binding jargon.
 */
export const PEER_NOT_BOUND_MESSAGE =
  "Peer delegation is not available in this session: peer tools are not wired into the daemon yet (Daemon RPC binding is not part of this prototype). See docs/peer-delegation.md.";
