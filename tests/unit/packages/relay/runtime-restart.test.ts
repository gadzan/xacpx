// Simulated hub restart, end-to-end across two in-process runtimes sharing ONE
// on-disk SQLite file (`:memory:` cannot survive a runtime, so a tmp file stands
// in for the hub's real db): runtime A streams a turn and "dies" mid-turn;
// runtime B recovers running turn + finished-offline rows from the connector's
// `instance.state.sync`; runtime C proves the dedup survives ANOTHER restart
// (the hub-side in-memory fingerprint set died with B — SQLite pair matching is
// the last line of defense against a redelivered finishedOffline entry).
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
      finishedOffline: [{ sessionAlias: "done", ok: true, text: "finished reply", prompt: "q" }],
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

    // ── Runtime C: the hub restarts AGAIN; the connector still hasn't seen a
    // confirmed flush and re-sends the same finishedOffline entry. The in-memory
    // fingerprint set died with B, so the SQLite prompt+reply PAIR match must
    // dedup it — while later genuine turns stay fully intact. ──────────────────
    const c = await createRelayRuntime(dbPath);
    sync(c, { turns: [], usage: [], commands: [], finishedOffline: snapshot.finishedOffline });
    expect(rows(c, "done")).toEqual([["in", "q"], ["out", "finished reply"]]);
    expect(rows(c, "backend")).toEqual([["in", "hi"], ["out", "hello"]]);
    c.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
