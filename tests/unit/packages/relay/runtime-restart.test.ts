// Hub restart semantics after history retirement (2026-11).
//
// The hub transcript is process-local memory: runtime A's rows die with A.
// What survives a restart on disk:
// - accounts / instances / pairing (control plane, untouched here),
// - recovery receipts (boot-independent dedup keys, no message content),
// - slot anchors are CLEARED on startup (they reference per-boot message ids).
//
// Recovery after a restart comes from the daemon's own mirror via
// `instance.state.sync`: running turns re-backfill their prompt rows, and
// finishedOffline entries the daemon never got acked for are re-persisted.
// An entry whose receipt already exists is dropped even though its rows are
// gone — a real daemon only re-sends unacked entries, and an acked entry was
// already delivered pre-restart.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "bun:test";
import { MSG, RELAY_PROTOCOL_VERSION } from "../../../../packages/relay-protocol/src/index";
import { createRelayRuntime, type RelayRuntime } from "../../../../packages/relay/src/server";

const STARTED_AT = 1_700_000_000_000;

function seedIdentity(runtime: RelayRuntime) {
  runtime.db.run("INSERT INTO accounts (id, username, created_at) VALUES (?,?,?)", ["a1", "u", "t"]);
  runtime.db.run("INSERT INTO instances (id, account_id, name, credential_hash, created_at) VALUES (?,?,?,?,?)", ["i1", "a1", "pc", "h", "t"]);
}

function fire(runtime: RelayRuntime, event: unknown) {
  runtime.gateway["deps"].onEvent!("i1", "a1", {
    protocolVersion: RELAY_PROTOCOL_VERSION, kind: "event", type: MSG.instanceEvent, payload: { event },
  });
}

function sync(runtime: RelayRuntime, payload: unknown) {
  runtime.gateway["deps"].onEvent!("i1", "a1", {
    protocolVersion: RELAY_PROTOCOL_VERSION, kind: "event", type: MSG.instanceStateSync, payload,
  });
}

const rows = (runtime: RelayRuntime, alias: string) =>
  runtime.messages.listBySession("a1", "i1", alias).messages.map((m) => [m.direction, m.text]);

test("hub restart: rows are per-boot, sync backfills from the daemon mirror, receipts dedup", async () => {
  const dir = mkdtempSync(join(tmpdir(), "relay-restart-"));
  const dbPath = join(dir, "relay.db");
  try {
    // ── Runtime A: a turn starts and streams; the hub "dies" mid-turn. ────────
    const a = await createRelayRuntime(dbPath);
    seedIdentity(a);
    fire(a, { type: "turn-started", chatKey: "relay:a1", sessionAlias: "backend", prompt: "hi" });
    fire(a, { type: "turn-output", chatKey: "relay:a1", sessionAlias: "backend", chunk: "hel" });
    a.close(); // hub restart: turnBuffers AND memory rows die with the process

    // ── Runtime B: daemon reconnects and pushes its mirror snapshot. ─────────
    const b = await createRelayRuntime(dbPath);
    const snapshot = {
      turns: [{ sessionAlias: "backend", startedAt: STARTED_AT, text: "hel", reasoning: "", steps: [], prompt: "hi" }],
      usage: [],
      commands: [],
      finishedOffline: [{ sessionAlias: "done", ok: true, text: "finished reply", prompt: "q", recoveryId: "done-1" }],
    };
    sync(b, snapshot);

    // Running turn restored with its ORIGINAL startedAt; the pre-outage prompt
    // row was backfilled (not duplicated) from the daemon mirror.
    expect(b.stateSnapshot("i1").turns.map((t) => [t.sessionAlias, t.startedAt])).toEqual([["backend", STARTED_AT]]);
    expect(rows(b, "backend")).toEqual([["in", "hi"]]);
    // The turn that finished entirely during the outage recovered as in+out.
    expect(rows(b, "done")).toEqual([["in", "q"], ["out", "finished reply"]]);

    // The restored turn keeps absorbing live events and flushes exactly one
    // complete out row (pre-restart mirror text + post-restart chunks).
    fire(b, { type: "turn-output", chatKey: "relay:a1", sessionAlias: "backend", chunk: "lo" });
    fire(b, { type: "turn-finished", chatKey: "relay:a1", sessionAlias: "backend", ok: true });
    expect(rows(b, "backend")).toEqual([["in", "hi"], ["out", "hello"]]);

    // A re-acked sync to the SAME runtime is idempotent for history rows.
    sync(b, { turns: [], usage: [], commands: [], finishedOffline: snapshot.finishedOffline });
    expect(rows(b, "done")).toHaveLength(2);
    b.close();

    // ── Runtime C: the hub restarts AGAIN. ────────────────────────────────────
    // Memory rows died with B. The receipt for done-1 (SQLite) survived, so a
    // pathologically re-sent finished entry is dropped, not resurrected — the
    // daemon already got its ack and a real daemon would not resend it. The
    // still-running turn IS backfilled again from the daemon's mirror.
    const c = await createRelayRuntime(dbPath);
    sync(c, {
      turns: [{ sessionAlias: "backend", startedAt: STARTED_AT, text: "hel", reasoning: "", steps: [], prompt: "hi" }],
      usage: [],
      commands: [],
      finishedOffline: snapshot.finishedOffline,
    });
    expect(rows(c, "done")).toEqual([]);
    expect(rows(c, "backend")).toEqual([["in", "hi"]]);
    c.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function receivedCard(messageId: string, createdAt: number) {
  return {
    type: "agent-message" as const,
    chatKey: "relay:a1",
    sessionAlias: "backend",
    message: {
      kind: "agent_message" as const,
      direction: "received" as const,
      messageId,
      conversationId: `conv_${messageId}`,
      peer: { handle: "agent:n:e", displayName: "Peer", agent: "codex" },
      content: messageId,
      createdAt,
      status: "delivered" as const,
    },
  };
}

test("hub restart drops dead-boot slot anchors; finishedOffline without prompt lands unanchored", async () => {
  const dir = mkdtempSync(join(tmpdir(), "relay-slot-"));
  const dbPath = join(dir, "relay.db");
  const turnStart = STARTED_AT;
  try {
    const a = await createRelayRuntime(dbPath);
    seedIdentity(a);
    fire(a, receivedCard("card1", turnStart - 1_000));
    fire(a, { type: "turn-started", chatKey: "relay:a1", sessionAlias: "backend", recoveryId: "r-slot", startedAfterSeq: 1 });
    const triggerId = a.messages.listBySession("a1", "i1", "backend").messages[0]!.id!;
    fire(a, receivedCard("card2", turnStart - 30_000));
    expect(a.messages.listBySession("a1", "i1", "backend").messages.map((m) => m.text)).toEqual(["card1", "card2"]);
    a.close();

    // Startup cleared the anchor (it referenced a dead-boot id); pre-restart
    // mid-turn cards do not resurrect — the daemon mirror carries only running
    // and finished turns, and this entry finished with no prompt to backfill.
    const b = await createRelayRuntime(dbPath);
    expect(b.slotAnchors.get("i1", "r-slot")).toBeUndefined();
    sync(b, {
      turns: [],
      usage: [],
      commands: [],
      finishedOffline: [{
        sessionAlias: "backend",
        ok: true,
        text: "reply",
        recoveryId: "r-slot",
        startedAfterSeq: 1,
        startedAt: turnStart,
      }],
    });
    const outRows = b.messages.listBySession("a1", "i1", "backend").messages;
    expect(outRows.map((m) => [m.direction, m.text])).toEqual([["out", "reply"]]);
    const out = outRows.find((m) => m.direction === "out");
    expect(out?.slotAfterId).toBe(0); // empty boot transcript: no anchor, no lastId
    expect(out?.startedAfterSeq).toBe(1);
    expect(typeof out?.startedAt).toBe("number");
    // The dead-boot trigger id is gone and must never reappear as an anchor.
    expect(out?.slotAfterId).not.toBe(triggerId);
    b.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("no-buffer turn-finished after hub restart lands without a dead-boot anchor", async () => {
  const dir = mkdtempSync(join(tmpdir(), "relay-nobuffer-"));
  const dbPath = join(dir, "relay.db");
  try {
    const a = await createRelayRuntime(dbPath);
    seedIdentity(a);
    fire(a, receivedCard("card1", STARTED_AT - 1_000));
    fire(a, { type: "turn-started", chatKey: "relay:a1", sessionAlias: "backend", recoveryId: "r-nb", startedAfterSeq: 2 });
    fire(a, receivedCard("card2", STARTED_AT + 10));
    a.close();

    const b = await createRelayRuntime(dbPath);
    fire(b, {
      type: "turn-finished",
      chatKey: "relay:a1",
      sessionAlias: "backend",
      ok: true,
      text: "offline reply",
      recoveryId: "r-nb",
      startedAfterSeq: 2,
      startedAt: STARTED_AT,
    });
    const outRows = b.messages.listBySession("a1", "i1", "backend").messages;
    const out = outRows.find((m) => m.direction === "out");
    expect(out?.text).toBe("offline reply");
    expect(out?.slotAfterId).toBe(0);
    expect(out?.startedAfterSeq).toBe(2);
    b.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an outage-started turn anchors to its own backfilled prompt row, never a dead boot's", async () => {
  const dir = mkdtempSync(join(tmpdir(), "relay-stale-anchor-"));
  const dbPath = join(dir, "relay.db");
  try {
    const a = await createRelayRuntime(dbPath);
    seedIdentity(a);
    fire(a, receivedCard("card1", STARTED_AT - 1_000));
    fire(a, { type: "turn-started", chatKey: "relay:a1", sessionAlias: "backend", recoveryId: "r-A", startedAfterSeq: 1 });
    const triggerA = a.messages.listBySession("a1", "i1", "backend").messages[0]!.id!;
    for (let i = 2; i <= 12; i++) fire(a, receivedCard(`card${i}`, STARTED_AT + i));
    const lastBeforeOutage = a.messages.listBySession("a1", "i1", "backend").messages.at(-1)!.id!;
    expect(lastBeforeOutage).toBeGreaterThan(triggerA);
    a.close();

    const b = await createRelayRuntime(dbPath);
    // Dead-boot anchors are gone at startup.
    expect(b.slotAnchors.get("i1", "r-A")).toBeUndefined();
    sync(b, {
      turns: [{
        sessionAlias: "backend",
        startedAt: STARTED_AT + 50_000,
        text: "B running",
        reasoning: "",
        steps: [],
        prompt: "turn B",
        recoveryId: "r-B",
        startedAfterSeq: 2,
      }],
      usage: [],
      commands: [],
      finishedOffline: [],
    });
    const promptB = b.messages.listBySession("a1", "i1", "backend").messages.find((m) => m.text === "turn B");
    expect(promptB).toBeDefined();
    const restored = b.stateSnapshot("i1").turns.find((t) => t.sessionAlias === "backend");
    expect(restored?.slotAfterId).toBe(promptB!.id);
    expect(restored?.slotAfterId).not.toBe(triggerA);
    expect(b.slotAnchors.get("i1", "r-B")?.slotAfterId).toBe(promptB!.id);
    b.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an outage-finished turn anchors to its own backfilled prompt row, never a dead boot's", async () => {
  const dir = mkdtempSync(join(tmpdir(), "relay-stale-finish-"));
  const dbPath = join(dir, "relay.db");
  try {
    const a = await createRelayRuntime(dbPath);
    seedIdentity(a);
    fire(a, receivedCard("card1", STARTED_AT - 1_000));
    fire(a, { type: "turn-started", chatKey: "relay:a1", sessionAlias: "backend", recoveryId: "r-A", startedAfterSeq: 1 });
    const triggerA = a.messages.listBySession("a1", "i1", "backend").messages[0]!.id!;
    for (let i = 2; i <= 12; i++) fire(a, receivedCard(`card${i}`, STARTED_AT + i));
    a.close();

    const b = await createRelayRuntime(dbPath);
    sync(b, {
      turns: [],
      usage: [],
      commands: [],
      finishedOffline: [{
        sessionAlias: "backend",
        ok: true,
        text: "B reply",
        prompt: "turn B",
        recoveryId: "r-B",
        startedAfterSeq: 2,
        startedAt: STARTED_AT + 50_000,
      }],
    });
    const found = b.messages.listBySession("a1", "i1", "backend").messages;
    const promptB = found.find((m) => m.text === "turn B");
    const out = found.find((m) => m.direction === "out");
    expect(promptB).toBeDefined();
    expect(out?.text).toBe("B reply");
    expect(out?.slotAfterId).toBe(promptB!.id);
    expect(out?.slotAfterId).not.toBe(triggerA);
    expect(b.slotAnchors.get("i1", "r-A")).toBeUndefined();
    b.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("legacy empty recoveryId backend+frontend each slot to their own backfilled prompt", async () => {
  const dir = mkdtempSync(join(tmpdir(), "relay-legacy-slot-"));
  const dbPath = join(dir, "relay.db");
  try {
    const a = await createRelayRuntime(dbPath);
    seedIdentity(a);
    fire(a, { ...receivedCard("be1", STARTED_AT - 1_000), sessionAlias: "backend" });
    fire(a, { type: "turn-started", chatKey: "relay:a1", sessionAlias: "backend", prompt: "be-prompt" });
    fire(a, { ...receivedCard("be2", STARTED_AT + 10), sessionAlias: "backend" });

    fire(a, { ...receivedCard("fe1", STARTED_AT - 1_000), sessionAlias: "frontend" });
    fire(a, { type: "turn-started", chatKey: "relay:a1", sessionAlias: "frontend", prompt: "fe-prompt" });
    fire(a, { ...receivedCard("fe2", STARTED_AT + 10), sessionAlias: "frontend" });
    a.close();

    // After a restart each session's restored turn slots to its own backfilled
    // prompt row (per-boot ids) — never to the other session's row.
    const b = await createRelayRuntime(dbPath);
    sync(b, {
      turns: [
        { sessionAlias: "backend", startedAt: STARTED_AT, text: "be-out", reasoning: "", steps: [], prompt: "be-prompt" },
        { sessionAlias: "frontend", startedAt: STARTED_AT, text: "fe-out", reasoning: "", steps: [], prompt: "fe-prompt" },
      ],
      usage: [],
      commands: [],
      finishedOffline: [],
    });
    const bePrompt = b.messages.listBySession("a1", "i1", "backend").messages.find((m) => m.text === "be-prompt");
    const fePrompt = b.messages.listBySession("a1", "i1", "frontend").messages.find((m) => m.text === "fe-prompt");
    expect(bePrompt).toBeDefined();
    expect(fePrompt).toBeDefined();
    expect(bePrompt!.id).not.toBe(fePrompt!.id);
    const turns = Object.fromEntries(b.stateSnapshot("i1").turns.map((t) => [t.sessionAlias, t.slotAfterId]));
    expect(turns.backend).toBe(bePrompt!.id);
    expect(turns.frontend).toBe(fePrompt!.id);
    b.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
