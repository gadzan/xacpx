// Ephemeral viewer/controller attachment registry — spec §13
// (docs/superpowers/specs/2026-08-10-relay-web-rmux-terminal-design.md).
//
// Attachments, controller role and recovery cursor state are intentionally
// NOT persisted (spec §10.1): this whole module lives only in memory and has
// zero knowledge of `TerminalRegistryStore` or `RmuxTerminalDriver`. That
// separation is deliberate: nothing in this file may kill a terminal resource
// or refresh its idle deadline — TTL expiry, heartbeat, detach, hitting
// `maxViewersPerTerminal`, and bulk (socket-disconnect) detach all only ever
// mutate viewer bookkeeping. It is `RelayTerminalRuntime`'s job (Task 13) to
// react to a resource-affecting decision (e.g. "no controller left") — this
// module never makes that decision itself.
import { randomUUID } from "node:crypto";

import { MAX_TERMINAL_ATTACHMENT_QUEUE_BYTES } from "@ganglion/xacpx-relay-protocol";

export type TerminalAttachmentRole = "controller" | "spectator";

export interface TerminalAttachment {
  readonly attachmentId: string;
  readonly viewerId: string;
  readonly terminalId: string;
  readonly generation: string;
  role: TerminalAttachmentRole;
  readonly attachedAt: number;
  lastHeartbeatAt: number;
}

export interface AttachInput {
  viewerId: string;
  terminalId: string;
  generation: string;
}

export interface AttachResult {
  attachmentId: string;
  role: TerminalAttachmentRole;
  viewerCount: number;
}

export interface TakeControlInput {
  attachmentId: string;
  generation: string;
}

export interface TakeControlResult {
  attachmentId: string;
  role: "controller";
  viewerCount: number;
}

export type TerminalAttachmentEvent =
  | { type: "role-changed"; attachmentId: string; terminalId: string; role: TerminalAttachmentRole; viewerCount: number }
  | { type: "queue-overflow"; attachmentId: string; terminalId: string };

export interface TerminalAttachmentsClock {
  now(): number;
}

export interface TerminalAttachmentsOptions {
  maxViewersPerTerminal: number;
  attachmentTtlMs: number;
  /** Per-attachment outbound byte cap before that attachment's recovery
   *  stream must be closed and resynced (spec §14.7). Defaults to the shared
   *  protocol constant so hub and connector never drift apart. */
  maxQueueBytes?: number;
  clock?: TerminalAttachmentsClock;
  onEvent?: (event: TerminalAttachmentEvent) => void;
  randomId?: () => string;
}

export class TerminalAttachmentNotFoundError extends Error {
  constructor(attachmentId: string) {
    super(`terminal attachment not found: ${attachmentId}`);
    this.name = "TerminalAttachmentNotFoundError";
  }
}

export class TerminalAttachmentGenerationMismatchError extends Error {
  constructor(attachmentId: string) {
    super(`terminal attachment generation mismatch: ${attachmentId}`);
    this.name = "TerminalAttachmentGenerationMismatchError";
  }
}

export class TerminalNotControllerError extends Error {
  constructor(attachmentId: string) {
    super(`terminal attachment is not the controller: ${attachmentId}`);
    this.name = "TerminalNotControllerError";
  }
}

export class TerminalViewerCapacityExceededError extends Error {
  constructor(terminalId: string) {
    super(`terminal viewer capacity exceeded: ${terminalId}`);
    this.name = "TerminalViewerCapacityExceededError";
  }
}

interface OutboundQueueState {
  bytes: number;
  closed: boolean;
}

/**
 * In-memory viewer/controller bookkeeping for terminal resources.
 *
 * Role assignment rule (spec §13.3): the first attachment for a terminal that
 * currently has no controller becomes controller; every other attachment
 * becomes a spectator. This is evaluated at attach-time against the *current*
 * set of attachments, not "was ever first" — so after an explicit controller
 * detach the terminal has no controller, and a genuinely new `attach()` call
 * fills that role, while EXISTING spectators are never silently promoted.
 */
export class TerminalAttachmentRegistry {
  private readonly attachments = new Map<string, TerminalAttachment>();
  private readonly byTerminal = new Map<string, Set<string>>();
  private readonly queues = new Map<string, OutboundQueueState>();
  private readonly clock: TerminalAttachmentsClock;
  private readonly onEvent: (event: TerminalAttachmentEvent) => void;
  private readonly randomId: () => string;
  private readonly maxViewersPerTerminal: number;
  private readonly attachmentTtlMs: number;
  private readonly maxQueueBytes: number;

  constructor(options: TerminalAttachmentsOptions) {
    this.maxViewersPerTerminal = options.maxViewersPerTerminal;
    this.attachmentTtlMs = options.attachmentTtlMs;
    this.maxQueueBytes = options.maxQueueBytes ?? MAX_TERMINAL_ATTACHMENT_QUEUE_BYTES;
    this.clock = options.clock ?? { now: () => Date.now() };
    this.onEvent = options.onEvent ?? (() => {});
    this.randomId = options.randomId ?? (() => randomUUID());
  }

  attach(input: AttachInput): AttachResult {
    const currentViewerCount = this.getViewerCount(input.terminalId);
    if (currentViewerCount >= this.maxViewersPerTerminal) {
      throw new TerminalViewerCapacityExceededError(input.terminalId);
    }

    const hasController = this.listByTerminal(input.terminalId).some((a) => a.role === "controller");
    const role: TerminalAttachmentRole = hasController ? "spectator" : "controller";
    const now = this.clock.now();
    const attachmentId = this.randomId();

    const attachment: TerminalAttachment = {
      attachmentId,
      viewerId: input.viewerId,
      terminalId: input.terminalId,
      generation: input.generation,
      role,
      attachedAt: now,
      lastHeartbeatAt: now,
    };

    this.attachments.set(attachmentId, attachment);
    this.indexByTerminal(input.terminalId).add(attachmentId);
    this.queues.set(attachmentId, { bytes: 0, closed: false });

    const viewerCount = this.recomputeAndBroadcast(input.terminalId);
    return { attachmentId, role, viewerCount };
  }

  /** Idempotent: detaching an unknown/already-detached attachment is a no-op. */
  detach(attachmentId: string): void {
    const attachment = this.attachments.get(attachmentId);
    if (!attachment) return;
    this.removeAttachment(attachment);
    this.recomputeAndBroadcast(attachment.terminalId);
  }

  /** Bulk variant for socket-disconnect cleanup (spec §12.2): the hub knows the
   *  exact attachmentIds bound to a closed connection. Unknown ids are
   *  ignored so a partially-stale list is still safe to pass in. */
  detachMany(attachmentIds: readonly string[]): void {
    const affectedTerminals = new Set<string>();
    for (const attachmentId of attachmentIds) {
      const attachment = this.attachments.get(attachmentId);
      if (!attachment) continue;
      this.removeAttachment(attachment);
      affectedTerminals.add(attachment.terminalId);
    }
    for (const terminalId of affectedTerminals) this.recomputeAndBroadcast(terminalId);
  }

  heartbeat(attachmentId: string): void {
    const attachment = this.requireAttachment(attachmentId);
    attachment.lastHeartbeatAt = this.clock.now();
  }

  /** Validates attachment + generation before the caller forwards raw input
   *  bytes to the driver. Throws, never silently drops. */
  assertCanInput(attachmentId: string, generation: string): void {
    this.assertController(attachmentId, generation);
  }

  /** Same validation as `assertCanInput` — kept as a separate name so call
   *  sites read clearly; spectators are rejected at this layer regardless of
   *  what the web UI already disabled. */
  assertCanResize(attachmentId: string, generation: string): void {
    this.assertController(attachmentId, generation);
  }

  takeControl(input: TakeControlInput): TakeControlResult {
    const attachment = this.requireAttachment(input.attachmentId);
    if (attachment.generation !== input.generation) {
      throw new TerminalAttachmentGenerationMismatchError(input.attachmentId);
    }

    if (attachment.role !== "controller") {
      // Mutate live map entries — listByTerminal() returns copies.
      for (const other of this.attachments.values()) {
        if (
          other.terminalId === attachment.terminalId &&
          other.attachmentId !== attachment.attachmentId &&
          other.role === "controller"
        ) {
          other.role = "spectator";
        }
      }
      attachment.role = "controller";
    }

    const viewerCount = this.recomputeAndBroadcast(attachment.terminalId);
    return { attachmentId: attachment.attachmentId, role: "controller", viewerCount };
  }

  getAttachment(attachmentId: string): TerminalAttachment | undefined {
    const attachment = this.attachments.get(attachmentId);
    return attachment ? { ...attachment } : undefined;
  }

  listByTerminal(terminalId: string): TerminalAttachment[] {
    const ids = this.byTerminal.get(terminalId);
    if (!ids) return [];
    const out: TerminalAttachment[] = [];
    for (const id of ids) {
      const attachment = this.attachments.get(id);
      if (attachment) out.push({ ...attachment });
    }
    return out;
  }

  getViewerCount(terminalId: string): number {
    return this.byTerminal.get(terminalId)?.size ?? 0;
  }

  /** Sweep pass driven by an injected/advanced clock — tests must never sleep
   *  for real (spec §22.2). Returns the attachmentIds that were expired. */
  expireStale(nowOverride?: number): string[] {
    const now = nowOverride ?? this.clock.now();
    const expired: string[] = [];
    for (const attachment of this.attachments.values()) {
      if (now - attachment.lastHeartbeatAt >= this.attachmentTtlMs) {
        expired.push(attachment.attachmentId);
      }
    }
    if (expired.length === 0) return expired;

    const affectedTerminals = new Set<string>();
    for (const attachmentId of expired) {
      const attachment = this.attachments.get(attachmentId);
      if (!attachment) continue;
      this.removeAttachment(attachment);
      affectedTerminals.add(attachment.terminalId);
    }
    for (const terminalId of affectedTerminals) this.recomputeAndBroadcast(terminalId);
    return expired;
  }

  /** Adds bytes to an attachment's outbound accounting. Returns `false` once
   *  this call pushed the queue over `maxQueueBytes` (or it was already
   *  closed) — the caller must close/resync that one recovery stream without
   *  touching any other attachment (spec §14.7). Unknown attachmentId is
   *  treated as an already-torn-down stream (`false`, no throw): the viewer
   *  may have detached in the same tick a byte was in flight. */
  enqueueOutbound(attachmentId: string, bytes: Uint8Array): boolean {
    const queue = this.queues.get(attachmentId);
    if (!queue || queue.closed) return false;
    queue.bytes += bytes.length;
    if (queue.bytes > this.maxQueueBytes) {
      queue.closed = true;
      const attachment = this.attachments.get(attachmentId);
      this.onEvent({
        type: "queue-overflow",
        attachmentId,
        terminalId: attachment?.terminalId ?? "",
      });
      return false;
    }
    return true;
  }

  isOutboundQueueClosed(attachmentId: string): boolean {
    return this.queues.get(attachmentId)?.closed ?? false;
  }

  getOutboundQueueBytes(attachmentId: string): number {
    return this.queues.get(attachmentId)?.bytes ?? 0;
  }

  /** Reopens a closed outbound queue once the client has resynced (protocol
   *  `terminal-resync`). Attachment/role/generation are untouched. */
  resetOutboundQueue(attachmentId: string): void {
    const queue = this.queues.get(attachmentId);
    if (queue) {
      queue.bytes = 0;
      queue.closed = false;
    }
  }

  // --- internals ---------------------------------------------------------

  private assertController(attachmentId: string, generation: string): void {
    const attachment = this.requireAttachment(attachmentId);
    if (attachment.generation !== generation) {
      throw new TerminalAttachmentGenerationMismatchError(attachmentId);
    }
    if (attachment.role !== "controller") {
      throw new TerminalNotControllerError(attachmentId);
    }
  }

  private requireAttachment(attachmentId: string): TerminalAttachment {
    const attachment = this.attachments.get(attachmentId);
    if (!attachment) throw new TerminalAttachmentNotFoundError(attachmentId);
    return attachment;
  }

  private indexByTerminal(terminalId: string): Set<string> {
    let ids = this.byTerminal.get(terminalId);
    if (!ids) {
      ids = new Set();
      this.byTerminal.set(terminalId, ids);
    }
    return ids;
  }

  private removeAttachment(attachment: TerminalAttachment): void {
    this.attachments.delete(attachment.attachmentId);
    this.queues.delete(attachment.attachmentId);
    const ids = this.byTerminal.get(attachment.terminalId);
    if (ids) {
      ids.delete(attachment.attachmentId);
      if (ids.size === 0) this.byTerminal.delete(attachment.terminalId);
    }
  }

  /** Recomputes viewerCount for `terminalId` and broadcasts `role-changed` to
   *  every attachment currently on it (spec: "attach/detach/takeControl/TTL
   *  expiry all recompute viewerCount and emit role-changed to affected
   *  attachments") — every existing viewer's displayed count is "affected" by
   *  any of these four actions, even when their own role does not change. */
  private recomputeAndBroadcast(terminalId: string): number {
    const attachments = this.listByTerminal(terminalId);
    const viewerCount = attachments.length;
    for (const attachment of attachments) {
      this.onEvent({
        type: "role-changed",
        attachmentId: attachment.attachmentId,
        terminalId,
        role: attachment.role,
        viewerCount,
      });
    }
    return viewerCount;
  }
}
