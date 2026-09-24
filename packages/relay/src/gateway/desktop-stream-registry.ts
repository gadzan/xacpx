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
    // Reap expired preparing/waiting reservations BEFORE counting: without this,
    // a browser that never attaches its binary socket would pin the instance
    // slot (and the account slot) forever. Synchronous, so the check + insert
    // below stay atomic within one hub event-loop turn.
    this.sweepExpired(now);
    this.sweepClosed();
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

  /** Terminal state: the record stays briefly so late binary upgrades fail closed. */
  close(streamId: string): DesktopStreamRecord | undefined {
    const record = this.records.get(streamId);
    if (!record) return undefined;
    record.state = "closed";
    return record;
  }

  closeForInstance(instanceId: string): DesktopStreamRecord[] {
    const closed: DesktopStreamRecord[] = [];
    for (const record of this.records.values()) {
      if (record.instanceId === instanceId && record.state !== "closed") {
        record.state = "closed";
        closed.push(record);
      }
    }
    return closed;
  }

  liveForInstance(instanceId: string): DesktopStreamRecord | undefined {
    return [...this.records.values()].find((r) => r.instanceId === instanceId && r.state !== "closed");
  }

  sweepExpired(now = this.now()): number {
    let closed = 0;
    for (const record of this.records.values()) {
      if (record.state !== "closed" && (record.state === "preparing" || record.state === "waiting-browser") && record.expiresAt <= now) {
        record.state = "closed";
        closed += 1;
      }
    }
    return closed;
  }

  private sweepClosed(): void {
    // Drop closed records once nothing can still reference them (single-use
    // tickets are already revoked at close time). Keeps the map bounded.
    for (const [id, record] of [...this.records]) {
      if (record.state === "closed") this.records.delete(id);
    }
  }

  size(): number {
    return this.records.size;
  }
}
