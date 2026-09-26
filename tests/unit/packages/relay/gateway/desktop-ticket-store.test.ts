import { expect, test } from "bun:test";

import { DesktopTicketStore } from "../../../../../packages/relay/src/gateway/desktop-ticket-store";

test("tickets are single-use, side-bound, and expiring", () => {
  let now = 1_000_000;
  const store = new DesktopTicketStore({ now: () => now, mint: (() => { let n = 0; return () => `ticket-${(n += 1)}`; })() });
  const issued = store.mintTicket({ streamId: "s1", accountId: "a1", instanceId: "i1", side: "browser" });
  expect(issued.expiresAt).toBe(now + 60_000);
  // Wrong side fails (and consumes the ticket: no cross-side replay).
  expect(store.consume(issued.ticket, "connector")).toBeNull();
  expect(store.consume(issued.ticket, "browser")).toBeNull();
  expect(store.size()).toBe(0);
});

test("ticket TTL expiry fails closed", () => {
  let now = 1_000_000;
  const store = new DesktopTicketStore({ now: () => now, mint: () => "t-expiry" });
  const issued = store.mintTicket({ streamId: "s1", accountId: "a1", instanceId: "i1", side: "connector" });
  expect(store.sweepExpired()).toBe(0);
  now += 60_001;
  expect(store.consume(issued.ticket, "connector")).toBeNull();
  expect(store.size()).toBe(0);
});

test("account mismatch consumes the ticket and fails closed", () => {
  const store = new DesktopTicketStore({ mint: (() => { let n = 0; return () => `t-${(n += 1)}`; })() });
  const issued = store.mintTicket({ streamId: "s1", accountId: "a1", instanceId: "i1", side: "browser" });
  // Cross-account presentation burns the ticket: the rightful owner's retry
  // afterwards must also fail rather than leave a usable ticket behind.
  expect(store.consume(issued.ticket, "browser", "b2")).toBeNull();
  expect(store.consume(issued.ticket, "browser", "a1")).toBeNull();
  expect(store.size()).toBe(0);
  const ok = store.mintTicket({ streamId: "s1", accountId: "a1", instanceId: "i1", side: "browser" });
  expect(store.consume(ok.ticket, "browser", "a1")?.streamId).toBe("s1");
});

test("unknown tickets fail and stream revocation drops pending tickets", () => {
  const store = new DesktopTicketStore({ mint: (() => { let n = 0; return () => `t-${(n += 1)}`; })() });
  expect(store.consume("nope", "browser")).toBeNull();
  const b = store.mintTicket({ streamId: "s1", accountId: "a1", instanceId: "i1", side: "browser" });
  const c = store.mintTicket({ streamId: "s1", accountId: "a1", instanceId: "i1", side: "connector" });
  expect(store.size()).toBe(2);
  store.revokeForStream("s1");
  expect(store.consume(b.ticket, "browser")).toBeNull();
  expect(store.consume(c.ticket, "connector")).toBeNull();
});
