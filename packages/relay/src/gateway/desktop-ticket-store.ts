// packages/relay/src/gateway/desktop-ticket-store.ts
// Single-use desktop stream tickets. Tickets bind (accountId, instanceId, side)
// and expire after DESKTOP_TICKET_TTL_MS; a consumed or expired ticket never
// validates again. In-memory only: a hub restart drops every active desktop
// stream and browsers re-open.

import { randomBytes } from "node:crypto";

import {
  DESKTOP_TICKET_TTL_MS,
  MAX_DESKTOP_STREAM_ID_LENGTH,
  MAX_DESKTOP_TICKET_LENGTH,
} from "@ganglion/xacpx-relay-protocol";

export type DesktopTicketSide = "browser" | "connector";

export interface DesktopTicket {
  ticket: string;
  streamId: string;
  accountId: string;
  instanceId: string;
  side: DesktopTicketSide;
  expiresAt: number;
}

export interface DesktopTicketStoreOptions {
  now?: () => number;
  mint?: () => string;
  ttlMs?: number;
}

function defaultMint(): string {
  return randomBytes(32).toString("base64url");
}

export class DesktopTicketStore {
  private readonly tickets = new Map<string, DesktopTicket>();
  private readonly now: () => number;
  private readonly mint: () => string;
  private readonly ttlMs: number;

  constructor(options: DesktopTicketStoreOptions = {}) {
    this.now = options.now ?? Date.now;
    this.mint = options.mint ?? defaultMint;
    this.ttlMs = options.ttlMs ?? DESKTOP_TICKET_TTL_MS;
  }

  mintTicket(input: {
    streamId: string;
    accountId: string;
    instanceId: string;
    side: DesktopTicketSide;
  }): DesktopTicket {
    if (!input.streamId || input.streamId.length > MAX_DESKTOP_STREAM_ID_LENGTH) {
      throw new Error("desktop ticket requires a bounded streamId");
    }
    if (!input.accountId || !input.instanceId) {
      throw new Error("desktop ticket requires accountId and instanceId");
    }
    const issued = this.mint();
    const ticket = issued.length > MAX_DESKTOP_TICKET_LENGTH
      ? issued.slice(0, MAX_DESKTOP_TICKET_LENGTH)
      : issued;
    if (!ticket) throw new Error("desktop ticket mint produced an empty ticket");
    const record: DesktopTicket = {
      ticket,
      streamId: input.streamId,
      accountId: input.accountId,
      instanceId: input.instanceId,
      side: input.side,
      expiresAt: this.now() + this.ttlMs,
    };
    // Mint collision (custom mint in tests): keep the first record, never overwrite.
    const existing = this.tickets.get(ticket);
    if (existing && (existing.expiresAt > this.now() || existing.streamId !== record.streamId)) {
      throw new Error("desktop ticket collision");
    }
    this.tickets.set(ticket, record);
    return record;
  }

  /**
   * Consume a ticket: single-use, side/expiry/account-checked. The ticket is
   * ALWAYS consumed (deleted) on first presentation — even when the account
   * or side mismatches — so a cross-account probe burns the ticket instead of
   * leaving it usable by its rightful owner afterwards.
   */
  consume(ticket: string, side: DesktopTicketSide, accountId?: string): DesktopTicket | null {
    const record = this.tickets.get(ticket);
    if (!record) return null;
    this.tickets.delete(ticket);
    if (record.side !== side) return null;
    if (record.expiresAt <= this.now()) return null;
    if (accountId !== undefined && record.accountId !== accountId) return null;
    return record;
  }

  revokeForStream(streamId: string): void {
    for (const [ticket, record] of [...this.tickets]) {
      if (record.streamId === streamId) this.tickets.delete(ticket);
    }
  }

  sweepExpired(): number {
    const now = this.now();
    let removed = 0;
    for (const [ticket, record] of [...this.tickets]) {
      if (record.expiresAt <= now) {
        this.tickets.delete(ticket);
        removed += 1;
      }
    }
    return removed;
  }

  size(): number {
    return this.tickets.size;
  }
}
