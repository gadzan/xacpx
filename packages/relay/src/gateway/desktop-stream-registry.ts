// packages/relay/src/gateway/desktop-stream-registry.ts
// Hub-side desktop stream registry: one active/preparing stream per instance
// (v1 single-viewer) plus a per-account concurrency cap. In-memory only; hub
// restart drops every stream and browsers re-open with fresh tickets.

import {
  DESKTOP_MAX_STREAMS_PER_ACCOUNT,
  DESKTOP_MAX_STREAMS_PER_INSTANCE,
} from "@ganglion/xacpx-relay-protocol";

export type DesktopStreamState = "preparing" | "waiting-browser" | "active" | "closed";

export interface DesktopStreamRecord {
  streamId: string;
  accountId: string;
  instanceId: string;
  state: DesktopStreamState;
  createdAt: number;
  /**
   * ADMISSION deadline: the last moment this reservation may wait for its
   * connector probe and browser attach. Extended when the browser ticket mints
   * (so a slow probe cannot outlive the ticket it just earned). NOT a session
   * lifetime — once the stream reaches `active` the RFB session runs until a
   * socket closes, the instance goes offline, or the viewer closes it.
   */
  expiresAt: number;
}

export interface DesktopStreamRegistryOptions {
  now?: () => number;
  maxStreamsPerInstance?: number;
  maxStreamsPerAccount?: number;
  createStreamId?: () => string;
}

export class DesktopStreamRegistry {
  private readonly records = new Map<string, DesktopStreamRecord>();
  private readonly now: () => number;
  private readonly maxPerInstance: number;
  private readonly maxPerAccount: number;
  private readonly createStreamId: () => string;
  private seq = 0;

  constructor(options: DesktopStreamRegistryOptions = {}) {
    this.now = options.now ?? Date.now;
    this.maxPerInstance = options.maxStreamsPerInstance ?? DESKTOP_MAX_STREAMS_PER_INSTANCE;
    this.maxPerAccount = options.maxStreamsPerAccount ?? DESKTOP_MAX_STREAMS_PER_ACCOUNT;
    this.createStreamId = options.createStreamId ?? (() => `ds-${Date.now().toString(36)}-${(this.seq += 1).toString(36)}`);
  }

  reserve(input: { accountId: string; instanceId: string; ttlMs: number }):
    | { ok: true; record: DesktopStreamRecord }
    | { ok: false; code: "desktop-busy"; scope: "instance" | "account" } {
    const now = this.now();
    // Lifetime cleanup MUST go through DesktopStreamGateway.reserve/sweepExpired
    // (closeStream per expired stream: paired sockets, pre-attach buffers,
    // tickets, owner notification). This method only drops already-closed
    // records, never expires live ones on its own: expiring here would orphan
    // a live connector tunnel and its buffered banner outside closeStream.
    this.pruneClosed();
    const liveForInstance = [...this.records.values()].filter(
      (r) => r.instanceId === input.instanceId && r.accountId === input.accountId && r.state !== "closed",
    );
    if (liveForInstance.length >= this.maxPerInstance) {
      return { ok: false, code: "desktop-busy", scope: "instance" };
    }
    const liveForAccount = [...this.records.values()].filter(
      (r) => r.accountId === input.accountId && r.state !== "closed",
    );
    if (liveForAccount.length >= this.maxPerAccount) {
      return { ok: false, code: "desktop-busy", scope: "account" };
    }
    const record: DesktopStreamRecord = {
      streamId: this.createStreamId(),
      accountId: input.accountId,
      instanceId: input.instanceId,
      state: "preparing",
      createdAt: now,
      expiresAt: now + input.ttlMs,
    };
    this.records.set(record.streamId, record);
    return { ok: true, record };
  }

  get(streamId: string): DesktopStreamRecord | undefined {
    return this.records.get(streamId);
  }

  setState(streamId: string, state: DesktopStreamState): DesktopStreamRecord | undefined {
    const record = this.records.get(streamId);
    if (!record || record.state === "closed") return undefined;
    record.state = state;
    return record;
  }

  /**
   * Push a non-closed record's deadline out. Used when the browser ticket is
   * minted (after the connector prepare succeeds): the reservation TTL started
   * at reserve() time, so without this the stream could be swept before its own
   * valid browser ticket expires. `max()` semantics — the deadline can only move
   * forward, never shorten a still-valid stream.
   */
  extendExpiry(streamId: string, expiresAt: number): DesktopStreamRecord | undefined {
    const record = this.records.get(streamId);
    if (!record || record.state === "closed") return undefined;
    if (expiresAt > record.expiresAt) record.expiresAt = expiresAt;
    return record;
  }

  /** True when the record exists, is not closed, and its deadline has not passed. */
  isLive(record: DesktopStreamRecord | undefined, now = this.now()): record is DesktopStreamRecord {
    return record !== undefined && record.state !== "closed" && record.expiresAt > now;
  }

  /** Terminal state: the record stays briefly so late binary upgrades fail closed. */
  close(streamId: string): DesktopStreamRecord | undefined {
    const record = this.records.get(streamId);
    if (!record) return undefined;
    record.state = "closed";
    return record;
  }

  /**
   * List live records for an instance WITHOUT marking them closed. The
   * gateway's closeForInstance owns the state transition via closeStream so
   * paired sockets, pre-attach buffers, tickets, and owner notification all
   * run exactly once. (Marking here first would make the following
   * closeStream look like a duplicate no-op and skip onStreamClosed.)
   */
  closeForInstance(instanceId: string): DesktopStreamRecord[] {
    return [...this.records.values()].filter((r) => r.instanceId === instanceId && r.state !== "closed");
  }

  /**
   * List records past their ADMISSION deadline WITHOUT marking them closed.
   * The gateway's sweepExpired owns the transition via closeStream (see
   * closeForInstance above for why pre-marking breaks idempotency).
   *
   * `expiresAt` is an admission deadline, not a session lifetime: it bounds how
   * long a reservation may wait for its connector probe and browser attach.
   * Once both sides pair and the stream goes `active` the RFB session runs
   * until a socket closes, the instance goes offline, or the viewer closes it —
   * never on a timer. Sweeping `active` records here would turn every desktop
   * into a one-minute experience and the design defines no session cap.
   */
  sweepExpired(now = this.now()): DesktopStreamRecord[] {
    return [...this.records.values()].filter(
      (r) =>
        (r.state === "preparing" || r.state === "waiting-browser") &&
        r.expiresAt <= now,
    );
  }

  pruneClosed(): void {
    // Drop closed records once nothing can still reference them (single-use
    // tickets are already revoked at close time). Keeps the map bounded.
    for (const [id, record] of [...this.records]) {
      if (record.state === "closed") this.records.delete(id);
    }
  }
}
