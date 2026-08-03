// Hub-side `instance.state.sync` reconciliation: replace in-memory state from the
// connector mirror, persist finished-offline turns, defend against malformed payloads.
import { expect, test } from "bun:test";
import {
  MSG, RELAY_PROTOCOL_VERSION,
} from "../../../../packages/relay-protocol/src/index";
import { createRelayRuntime } from "../../../../packages/relay/src/server";
import type { RelayLogger } from "../../../../packages/relay/src/logging";

const STARTED_AT = 1_700_000_000_000;

function recordingLogger() {
  const records: Array<{ level: string; event: string }> = [];
  const logger: RelayLogger = {
    debug: (event) => records.push({ level: "debug", event }),
    info: (event) => records.push({ level: "info", event }),
    error: (event) => records.push({ level: "error", event }),
  };
  return { logger, records };
}

async function seeded() {
  const capture = recordingLogger();
  const runtime = await createRelayRuntime(":memory:", { logger: capture.logger });
  runtime.db.run("INSERT INTO accounts (id, username, created_at) VALUES (?,?,?)", ["a1", "u", "t"]);
  runtime.db.run("INSERT INTO instances (id, account_id, name, credential_hash, created_at) VALUES (?,?,?,?,?)", ["i1", "a1", "pc", "h", "t"]);
  return { ...capture, runtime };
}

function sync(runtime: Awaited<ReturnType<typeof seeded>>["runtime"], payload: unknown) {
  runtime.gateway["deps"].onEvent!("i1", "a1", {
    protocolVersion: RELAY_PROTOCOL_VERSION, kind: "event", type: MSG.instanceStateSync, payload,
  });
}

test("state sync restores turns/usage/commands into stateSnapshot with the original startedAt", async () => {
  const { runtime } = await seeded();
  sync(runtime, {
    turns: [{
      sessionAlias: "backend", startedAt: STARTED_AT, text: "partial reply", reasoning: "hmm",
      steps: [{ toolCallId: "t1", toolName: "Bash", kind: "execute", status: "success", title: "ls" }],
    }],
    usage: [{ sessionAlias: "backend", used: 11, size: 200, cost: { amount: 0.5, currency: "USD" } }],
    commands: [{ sessionAlias: "backend", commands: [{ name: "compact", hasInput: false }] }],
    finishedOffline: [],
  });

  const snapshot = runtime.stateSnapshot("i1");
  expect(snapshot.turns).toEqual([{
    instanceId: "i1", sessionAlias: "backend", status: "streaming", startedAt: STARTED_AT,
    parts: [
      { type: "tool", step: { toolCallId: "t1", toolName: "Bash", kind: "execute", status: "success", title: "ls" } },
      { type: "reasoning", text: "hmm" },
      { type: "text", text: "partial reply" },
    ],
  }]);
  expect(snapshot.usage).toEqual([{ instanceId: "i1", sessionAlias: "backend", used: 11, size: 200, cost: { amount: 0.5, currency: "USD" } }]);
  expect(snapshot.commands).toEqual([{ instanceId: "i1", sessionAlias: "backend", commands: [{ name: "compact", hasInput: false }] }]);
  runtime.close();
});

test("malformed sync payload is dropped + logged, existing state untouched", async () => {
  const { runtime, records } = await seeded();
  const fire = (event: unknown) => runtime.gateway["deps"].onEvent!("i1", "a1", {
    protocolVersion: RELAY_PROTOCOL_VERSION, kind: "event", type: MSG.instanceEvent, payload: { event },
  });
  fire({ type: "turn-started", chatKey: "relay:a1", sessionAlias: "backend" });
  fire({ type: "turn-output", chatKey: "relay:a1", sessionAlias: "backend", chunk: "keep me" });
  const before = runtime.stateSnapshot("i1");

  sync(runtime, { turns: "nope", usage: [], commands: [], finishedOffline: [] });
  sync(runtime, null);
  sync(runtime, { turns: [{ sessionAlias: 42 }], usage: [], commands: [], finishedOffline: [] });

  expect(runtime.stateSnapshot("i1")).toEqual(before);
  expect(records.filter((r) => r.event === "relay.event.invalid")).toHaveLength(3);
  runtime.close();
});

test("a re-sent sync replaces the instance's state without duplicating entries", async () => {
  const { runtime } = await seeded();
  sync(runtime, {
    turns: [{ sessionAlias: "backend", startedAt: STARTED_AT, text: "a", reasoning: "", steps: [] }],
    usage: [{ sessionAlias: "backend", used: 1, size: 10 }],
    commands: [{ sessionAlias: "backend", commands: [{ name: "c" }] }],
    finishedOffline: [],
  });
  sync(runtime, {
    turns: [],
    usage: [{ sessionAlias: "backend", used: 2, size: 10 }],
    commands: [],
    finishedOffline: [],
  });
  const snapshot = runtime.stateSnapshot("i1");
  expect(snapshot.turns).toEqual([]);
  expect(snapshot.usage).toEqual([{ instanceId: "i1", sessionAlias: "backend", used: 2, size: 10 }]);
  expect(snapshot.commands).toEqual([]);
  runtime.close();
});

test("finishedOffline rows are persisted; aliases present in turns are skipped", async () => {
  const { runtime } = await seeded();
  sync(runtime, {
    turns: [{ sessionAlias: "live", startedAt: STARTED_AT, text: "still running", reasoning: "", steps: [] }],
    usage: [],
    commands: [],
    finishedOffline: [
      { sessionAlias: "done", ok: true, text: "offline reply" },
      { sessionAlias: "failed", ok: false, errorMessage: "agent exploded" },
      { sessionAlias: "quiet-ok", ok: true }, // no text → no row (never fabricate empty entries)
      { sessionAlias: "live", ok: true, text: "contradictory" }, // also in turns → skipped
    ],
  });
  const rows = (alias: string) => runtime.messages.listBySession("a1", "i1", alias).messages;
  expect(rows("done").map((m) => [m.direction, m.text])).toEqual([["out", "offline reply"]]);
  expect(rows("failed").map((m) => [m.direction, m.text])).toEqual([["out", "agent exploded"]]);
  expect(rows("quiet-ok")).toEqual([]);
  expect(rows("live")).toEqual([]);
  runtime.close();
});

test("a re-sent sync does not duplicate finishedOffline rows", async () => {
  const { runtime } = await seeded();
  const payload = {
    turns: [],
    usage: [],
    commands: [],
    finishedOffline: [
      { sessionAlias: "done", ok: true, text: "offline reply" },
      { sessionAlias: "failed", ok: false, errorMessage: "agent exploded" },
    ],
  };
  sync(runtime, payload);
  sync(runtime, payload); // unconfirmed send → connector re-sends the same snapshot
  expect(runtime.messages.listBySession("a1", "i1", "done").messages.map((m) => [m.direction, m.text])).toEqual([["out", "offline reply"]]);
  expect(runtime.messages.listBySession("a1", "i1", "failed").messages.map((m) => [m.direction, m.text])).toEqual([["out", "agent exploded"]]);
  runtime.close();
});

test("a turn that started AND finished during the outage recovers as an in+out pair", async () => {
  const { runtime } = await seeded();
  sync(runtime, {
    turns: [],
    usage: [],
    commands: [],
    finishedOffline: [{ sessionAlias: "backend", ok: true, text: "offline reply", prompt: "deploy it" }],
  });
  // Prompt backfilled BEFORE the answer — no orphan out row in history.
  expect(runtime.messages.listBySession("a1", "i1", "backend").messages.map((m) => [m.direction, m.text]))
    .toEqual([["in", "deploy it"], ["out", "offline reply"]]);

  // A re-send dedupes both rows.
  sync(runtime, {
    turns: [],
    usage: [],
    commands: [],
    finishedOffline: [{ sessionAlias: "backend", ok: true, text: "offline reply", prompt: "deploy it" }],
  });
  expect(runtime.messages.listBySession("a1", "i1", "backend").messages).toHaveLength(2);
  runtime.close();
});

test("a prompt persisted before the outage is not duplicated by the backfill", async () => {
  const { runtime } = await seeded();
  const fire = (event: unknown) => runtime.gateway["deps"].onEvent!("i1", "a1", {
    protocolVersion: RELAY_PROTOCOL_VERSION, kind: "event", type: MSG.instanceEvent, payload: { event },
  });
  // Pre-restart: the live turn-started already persisted the prompt.
  fire({ type: "turn-started", chatKey: "relay:a1", sessionAlias: "backend", prompt: "hi" });
  // The hub "restarts" (fresh sync carries the still-running turn with its prompt).
  sync(runtime, {
    turns: [{ sessionAlias: "backend", startedAt: STARTED_AT, text: "work", reasoning: "", steps: [], prompt: "hi" }],
    usage: [],
    commands: [],
    finishedOffline: [{ sessionAlias: "backend", ok: true, text: "r", prompt: "hi" }], // contradictory: also in turns → skipped
  });
  expect(runtime.messages.listBySession("a1", "i1", "backend").messages.map((m) => [m.direction, m.text])).toEqual([["in", "hi"]]);
  // And the contradictory finishedOffline entry was skipped in favour of the live turn.
  expect(runtime.stateSnapshot("i1").turns).toHaveLength(1);
  runtime.close();
});

test("a restored turn with a prompt missing from history gets its in row backfilled", async () => {
  const { runtime } = await seeded();
  sync(runtime, {
    turns: [{ sessionAlias: "backend", startedAt: STARTED_AT, text: "work", reasoning: "", steps: [], prompt: "hi" }],
    usage: [],
    commands: [],
    finishedOffline: [],
  });
  expect(runtime.messages.listBySession("a1", "i1", "backend").messages.map((m) => [m.direction, m.text])).toEqual([["in", "hi"]]);
  runtime.close();
});

test("a restored turn keeps absorbing live events and flushes exactly one complete out row", async () => {
  const { runtime } = await seeded();
  sync(runtime, {
    turns: [{ sessionAlias: "backend", startedAt: STARTED_AT, text: "par", reasoning: "", steps: [] }],
    usage: [],
    commands: [],
    finishedOffline: [],
  });
  const fire = (event: unknown) => runtime.gateway["deps"].onEvent!("i1", "a1", {
    protocolVersion: RELAY_PROTOCOL_VERSION, kind: "event", type: MSG.instanceEvent, payload: { event },
  });
  fire({ type: "turn-output", chatKey: "relay:a1", sessionAlias: "backend", chunk: "tial" });
  fire({ type: "turn-finished", chatKey: "relay:a1", sessionAlias: "backend", ok: true });

  const cached = runtime.messages.listBySession("a1", "i1", "backend").messages;
  expect(cached).toHaveLength(1);
  expect(cached[0].direction).toBe("out");
  expect(cached[0].text).toBe("partial"); // pre-restart mirror text + post-restart chunks
  // Text-only turns persist without `structured` (same as the live flush path).
  expect(cached[0].structured).toBeUndefined();
  expect(runtime.stateSnapshot("i1").turns).toEqual([]); // buffer flushed
  runtime.close();
});
