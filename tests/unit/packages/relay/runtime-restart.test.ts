// Simulated hub restart, end-to-end across two in-process runtimes sharing ONE
// on-disk SQLite file (`:memory:` cannot survive a runtime, so a tmp file stands
// in for the hub's real db): runtime A streams a turn and "dies" mid-turn;
// runtime B recovers running turn + finished-offline rows from the connector's
// `instance.state.sync`; runtime C proves the dedup survives ANOTHER restart
// (the hub-side in-memory fingerprint set died with B — the SQLite recovery
// receipt, written in the same transaction as the rows, is the last line of
// defense against a redelivered finishedOffline entry).
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

test("simulated hub restart: turn/rows recover via state sync, flush once, dedup across restarts", async () => {
  const dir = mkdtempSync(join(tmpdir(), "relay-restart-"));
  const dbPath = join(dir, "relay.db");
  try {
    // ── Runtime A: a turn starts and streams; the hub "dies" mid-turn. ────────
    const a = await createRelayRuntime(dbPath);
    seedIdentity(a);
    fire(a, { type: "turn-started", chatKey: "relay:a1", sessionAlias: "backend", prompt: "hi" });
    fire(a, { type: "turn-output", chatKey: "relay:a1", sessionAlias: "backend", chunk: "hel" });
    a.close(); // hub restart: turnBuffers die with the process, the db survives

    // ── Runtime B: connector reconnects and pushes its mirror snapshot. ───────
    const b = await createRelayRuntime(dbPath);
    const snapshot = {
      turns: [{ sessionAlias: "backend", startedAt: STARTED_AT, text: "hel", reasoning: "", steps: [], prompt: "hi" }],
      usage: [],
      commands: [],
      finishedOffline: [{ sessionAlias: "done", ok: true, text: "finished reply", prompt: "q", recoveryId: "done-1" }],
    };
    sync(b, snapshot);

    // Running turn restored with its ORIGINAL startedAt; the pre-outage prompt
    // row was not duplicated by the backfill.
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

    // ── Runtime C: the hub restarts AGAIN; the connector still hasn't seen an
    // ack and re-sends the same finishedOffline entry. The in-memory fingerprint
    // set died with B, but the recovery receipt (same transaction as the rows)
    // survives in SQLite and dedups it — while later genuine turns stay intact. ──
    const c = await createRelayRuntime(dbPath);
    sync(c, { turns: [], usage: [], commands: [], finishedOffline: snapshot.finishedOffline });
    expect(rows(c, "done")).toEqual([["in", "q"], ["out", "finished reply"]]);
    expect(rows(c, "backend")).toEqual([["in", "hi"], ["out", "hello"]]);
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

test("hub restart + finishedOffline persists slotAfterId from turn-start, not lastId or clocks", async () => {
  const dir = mkdtempSync(join(tmpdir(), "relay-slot-"));
  const dbPath = join(dir, "relay.db");
  const turnStart = STARTED_AT;
  const peerBehind = turnStart - 30_000;
  try {
    const a = await createRelayRuntime(dbPath);
    seedIdentity(a);
    fire(a, receivedCard("card1", turnStart - 1_000));
    fire(a, { type: "turn-started", chatKey: "relay:a1", sessionAlias: "backend", recoveryId: "r-slot", startedAfterSeq: 1 });
    const afterStart = a.messages.listBySession("a1", "i1", "backend").messages;
    const triggerId = afterStart[0]!.id!;
    fire(a, receivedCard("card2", peerBehind));
    expect(a.messages.listBySession("a1", "i1", "backend").messages.map((m) => m.text)).toEqual(["card1", "card2"]);
    a.close();

    const b = await createRelayRuntime(dbPath);
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
    const rows = b.messages.listBySession("a1", "i1", "backend").messages;
    expect(rows.map((m) => m.text)).toEqual(["card1", "card2", "reply"]);
    const out = rows.find((m) => m.direction === "out");
    expect(out?.slotAfterId).toBe(triggerId);
    expect(out?.startedAfterSeq).toBe(1);
    expect(typeof out?.startedAt).toBe("number");
    // Insert order is still trigger, mid-turn card, out — web reorders by slotAfterId.
    expect(rows[0]!.id).toBe(triggerId);
    expect(rows[1]!.text).toBe("card2");
    b.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("no-buffer turn-finished after hub restart uses the durable slot anchor", async () => {
  const dir = mkdtempSync(join(tmpdir(), "relay-nobuffer-"));
  const dbPath = join(dir, "relay.db");
  try {
    const a = await createRelayRuntime(dbPath);
    seedIdentity(a);
    fire(a, receivedCard("card1", STARTED_AT - 1_000));
    fire(a, { type: "turn-started", chatKey: "relay:a1", sessionAlias: "backend", recoveryId: "r-nb", startedAfterSeq: 2 });
    const triggerId = a.messages.listBySession("a1", "i1", "backend").messages[0]!.id!;
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
    const rows = b.messages.listBySession("a1", "i1", "backend").messages;
    const out = rows.find((m) => m.direction === "out");
    expect(out?.text).toBe("offline reply");
    expect(out?.slotAfterId).toBe(triggerId);
    expect(out?.startedAfterSeq).toBe(2);
    b.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("leftover anchor A is not inherited by outage-started turn B (uses post-reconcile lastId)", async () => {
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
    expect(a.slotAnchors.get("i1", "r-A")?.slotAfterId).toBe(triggerA);
    a.close();

    const b = await createRelayRuntime(dbPath);
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
    expect(b.slotAnchors.get("i1", "r-A")).toBeUndefined();
    expect(b.slotAnchors.get("i1", "r-B")?.slotAfterId).toBe(promptB!.id);
    b.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("leftover anchor A is not inherited by finishedOffline B (uses post-reconcile lastId)", async () => {
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
    const rows = b.messages.listBySession("a1", "i1", "backend").messages;
    const promptB = rows.find((m) => m.text === "turn B");
    const out = rows.find((m) => m.direction === "out");
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

test("legacy empty recoveryId backend+frontend each restore their own slot after hub restart", async () => {
  const dir = mkdtempSync(join(tmpdir(), "relay-legacy-slot-"));
  const dbPath = join(dir, "relay.db");
  try {
    const a = await createRelayRuntime(dbPath);
    seedIdentity(a);
    fire(a, { ...receivedCard("be1", STARTED_AT - 1_000), sessionAlias: "backend" });
    fire(a, { type: "turn-started", chatKey: "relay:a1", sessionAlias: "backend", prompt: "be-prompt" });
    const backendSlot = a.messages.listBySession("a1", "i1", "backend").messages.at(-1)!.id!;
    fire(a, { ...receivedCard("be2", STARTED_AT + 10), sessionAlias: "backend" });

    fire(a, { ...receivedCard("fe1", STARTED_AT - 1_000), sessionAlias: "frontend" });
    fire(a, { type: "turn-started", chatKey: "relay:a1", sessionAlias: "frontend", prompt: "fe-prompt" });
    const frontendSlot = a.messages.listBySession("a1", "i1", "frontend").messages.at(-1)!.id!;
    fire(a, { ...receivedCard("fe2", STARTED_AT + 10), sessionAlias: "frontend" });
    expect(backendSlot).not.toBe(frontendSlot);
    a.close();

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
    const turns = Object.fromEntries(b.stateSnapshot("i1").turns.map((t) => [t.sessionAlias, t.slotAfterId]));
    expect(turns.backend).toBe(backendSlot);
    expect(turns.frontend).toBe(frontendSlot);
    b.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
