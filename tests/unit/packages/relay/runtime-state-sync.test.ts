// Hub-side `instance.state.sync` reconciliation: replace in-memory state from the
// connector mirror, persist finished-offline turns, defend against malformed payloads.
import { expect, test } from "bun:test";
import { decodeEnvelope, MSG, RELAY_PROTOCOL_VERSION } from "../../../../packages/relay-protocol/src/index";
import { createRelayRuntime } from "../../../../packages/relay/src/server";
import type { RelayLogger } from "../../../../packages/relay/src/logging";

const STARTED_AT = 1_700_000_000_000;

function recordingLogger() {
  const records: Array<{ level: string; event: string }> = [];
  const logger: RelayLogger = {
    debug: (event) => records.push({ level: "debug", event }),
    info: (event) => records.push({ level: "info", event }),
    warn: (event) => records.push({ level: "warn", event }),
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
      parts: [
        { type: "text", text: "before" },
        { type: "tool", step: { toolCallId: "t1", toolName: "Bash", kind: "execute", status: "success", title: "ls" } },
        { type: "text", text: "after" },
      ],
    }],
    usage: [{ sessionAlias: "backend", used: 11, size: 200, cost: { amount: 0.5, currency: "USD" } }],
    commands: [{ sessionAlias: "backend", commands: [{ name: "compact", hasInput: false }] }],
    finishedOffline: [],
  });

  const snapshot = runtime.stateSnapshot("i1");
  expect(snapshot.turns).toEqual([{
    instanceId: "i1", sessionAlias: "backend", status: "streaming", startedAt: STARTED_AT,
    parts: [
      { type: "text", text: "before" },
      { type: "tool", step: { toolCallId: "t1", toolName: "Bash", kind: "execute", status: "success", title: "ls" } },
      { type: "text", text: "after" },
    ],
  }]);
  expect(snapshot.usage).toEqual([{ instanceId: "i1", sessionAlias: "backend", used: 11, size: 200, cost: { amount: 0.5, currency: "USD" } }]);
  expect(snapshot.commands).toEqual([{ instanceId: "i1", sessionAlias: "backend", commands: [{ name: "compact", hasInput: false }] }]);
  runtime.close();
});

test("state sync broadcasts a fresh snapshot to an already-subscribed browser", async () => {
  const { runtime } = await seeded();
  const sent: string[] = [];
  const socket = { readyState: 1, send: (data: string) => sent.push(data), on: () => {} };
  runtime.webGateway.register("a1", socket);
  runtime.webGateway.setSubscription(socket, ["i1"]);
  sync(runtime, {
    turns: [{ sessionAlias: "backend", startedAt: STARTED_AT, text: "x", reasoning: "", steps: [], parts: [{ type: "text", text: "x" }] }],
    usage: [], commands: [], finishedOffline: [],
  });
  const decoded = decodeEnvelope(sent.at(-1)!);
  expect(decoded.ok && decoded.envelope.payload).toMatchObject({ kind: "state-snapshot", instanceId: "i1", turns: [{ sessionAlias: "backend" }] });
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


test("two different turns with coincidentally identical reply text are both persisted", async () => {
  const { runtime } = await seeded();
  // First outage: turn "first" finished offline with reply "ok" and is recovered.
  sync(runtime, {
    turns: [], usage: [], commands: [],
    finishedOffline: [{ sessionAlias: "backend", ok: true, prompt: "first", text: "ok" }],
  });
  // Second outage: a DIFFERENT turn ("second") also replied "ok". A bare text-match
  // dedup would find the recovered out("ok") row and silently drop this turn — the
  // exact history hole this recovery is meant to close. Pair matching keeps it.
  sync(runtime, {
    turns: [], usage: [], commands: [],
    finishedOffline: [{ sessionAlias: "backend", ok: true, prompt: "second", text: "ok" }],
  });
  expect(runtime.messages.listBySession("a1", "i1", "backend").messages.map((m) => [m.direction, m.text]))
    .toEqual([["in", "first"], ["out", "ok"], ["in", "second"], ["out", "ok"]]);
  runtime.close();
});

test("a re-sent sync for the SAME turn is still deduped despite identical content", async () => {
  const { runtime } = await seeded();
  const payload = {
    turns: [], usage: [], commands: [],
    finishedOffline: [{ sessionAlias: "backend", ok: true, prompt: "first", text: "ok" }],
  };
  sync(runtime, payload);
  sync(runtime, payload); // unconfirmed flush → same snapshot delivered again
  expect(runtime.messages.listBySession("a1", "i1", "backend").messages.map((m) => [m.direction, m.text]))
    .toEqual([["in", "first"], ["out", "ok"]]);
  runtime.close();
});

test("stable recovery ids preserve two genuinely identical offline turns", async () => {
  const { runtime } = await seeded();
  const entry = (recoveryId: string) => ({ sessionAlias: "backend", ok: true, prompt: "retry", text: "ok", recoveryId });
  sync(runtime, { turns: [], usage: [], commands: [], finishedOffline: [entry("r1"), entry("r2")] });
  sync(runtime, { turns: [], usage: [], commands: [], finishedOffline: [entry("r1")] });
  expect(runtime.messages.listBySession("a1", "i1", "backend").messages.map((m) => [m.direction, m.text]))
    .toEqual([["in", "retry"], ["out", "ok"], ["in", "retry"], ["out", "ok"]]);
  runtime.close();
});

test("a live finish received before an ambiguous send failure dedupes the later recovery sync", async () => {
  const { runtime } = await seeded();
  const fire = (event: unknown) => runtime.gateway["deps"].onEvent!("i1", "a1", {
    protocolVersion: RELAY_PROTOCOL_VERSION, kind: "event", type: MSG.instanceEvent, payload: { event },
  });
  fire({ type: "turn-started", chatKey: "relay:a1", sessionAlias: "backend", prompt: "q" });
  fire({ type: "turn-output", chatKey: "relay:a1", sessionAlias: "backend", chunk: "answer" });
  fire({ type: "turn-finished", chatKey: "relay:a1", sessionAlias: "backend", ok: true, recoveryId: "r1" });
  sync(runtime, { turns: [], usage: [], commands: [], finishedOffline: [{ sessionAlias: "backend", ok: true, prompt: "q", text: "answer", recoveryId: "r1" }] });
  expect(runtime.messages.listBySession("a1", "i1", "backend").messages.map((m) => [m.direction, m.text]))
    .toEqual([["in", "q"], ["out", "answer"]]);
  runtime.close();
});

test("a repeated prompt with a different reply recovers as a new in-out pair", async () => {
  const { runtime } = await seeded();
  sync(runtime, { turns: [], usage: [], commands: [], finishedOffline: [{ sessionAlias: "backend", ok: true, prompt: "retry", text: "A", recoveryId: "r1" }] });
  sync(runtime, { turns: [], usage: [], commands: [], finishedOffline: [{ sessionAlias: "backend", ok: true, prompt: "retry", text: "B", recoveryId: "r2" }] });
  expect(runtime.messages.listBySession("a1", "i1", "backend").messages.map((m) => [m.direction, m.text]))
    .toEqual([["in", "retry"], ["out", "A"], ["in", "retry"], ["out", "B"]]);
  runtime.close();
});

test("a finishedOffline turn with empty-string text still persists its (empty) reply row", async () => {
  const { runtime } = await seeded();
  // Presence semantics: text: "" is a carried reply. It must not be misread as
  // "no content" and skipped the way an absent text is.
  sync(runtime, {
    turns: [], usage: [], commands: [],
    finishedOffline: [{ sessionAlias: "backend", ok: true, prompt: "q", text: "" }],
  });
  expect(runtime.messages.listBySession("a1", "i1", "backend").messages.map((m) => [m.direction, m.text]))
    .toEqual([["in", "q"], ["out", ""]]);
  runtime.close();
});

test("a failed offline turn with an empty text persists its errorMessage, not an empty row", async () => {
  const { runtime } = await seeded();
  // Legacy/buggy connectors may ship text:"" next to errorMessage (the mirror used
  // to start accumulators at ""); the hub must prefer the error text on failure.
  sync(runtime, {
    turns: [], usage: [], commands: [],
    finishedOffline: [{ sessionAlias: "backend", ok: false, errorMessage: "boom", text: "", prompt: "deploy" }],
  });
  expect(runtime.messages.listBySession("a1", "i1", "backend").messages.map((m) => [m.direction, m.text]))
    .toEqual([["in", "deploy"], ["out", "boom"]]);
  runtime.close();
});

test("a truncated offline reply is persisted with the flag in its structured metadata", async () => {
  const { runtime } = await seeded();
  sync(runtime, {
    turns: [], usage: [], commands: [],
    finishedOffline: [{ sessionAlias: "backend", ok: true, text: "capped", prompt: "q", truncated: true }],
  });
  const rows = runtime.messages.listBySession("a1", "i1", "backend").messages;
  expect(rows.map((m) => [m.direction, m.text])).toEqual([["in", "q"], ["out", "capped"]]);
  expect(rows[1]!.structured).toEqual({ truncated: true });
  runtime.close();
});

test("sync acks committed recovery ids; a redelivery re-acks without duplicating rows", async () => {
  const { runtime } = await seeded();
  const acks: Array<{ type: string; payload: unknown }> = [];
  const original = runtime.gateway.sendEvent.bind(runtime.gateway);
  runtime.gateway.sendEvent = ((instanceId: string, type: string, payload: unknown) => {
    acks.push({ type, payload });
    return original(instanceId, type, payload);
  }) as typeof runtime.gateway.sendEvent;
  const payload = {
    turns: [], usage: [], commands: [],
    finishedOffline: [{ sessionAlias: "done", ok: true, text: "offline reply", prompt: "q", recoveryId: "r1" }],
  };
  sync(runtime, payload);
  expect(runtime.messages.listBySession("a1", "i1", "done").messages.map((m) => [m.direction, m.text]))
    .toEqual([["in", "q"], ["out", "offline reply"]]);
  expect(acks).toEqual([{ type: MSG.instanceRecoveryAck, payload: { recoveryIds: ["r1"] } }]);

  // Connector never got the ack → redelivers the same entry. The receipt (written
  // in the same transaction as the rows) dedups it; the hub re-acks so the
  // connector's FIFO can finally drop the entry.
  acks.length = 0;
  sync(runtime, payload);
  expect(runtime.messages.listBySession("a1", "i1", "done").messages.map((m) => [m.direction, m.text]))
    .toEqual([["in", "q"], ["out", "offline reply"]]);
  expect(acks).toEqual([{ type: MSG.instanceRecoveryAck, payload: { recoveryIds: ["r1"] } }]);
  runtime.close();
});

test("a live turn-finished with a recovery id is acked after its transactional flush", async () => {
  const { runtime } = await seeded();
  const acks: Array<{ type: string; payload: unknown }> = [];
  const original = runtime.gateway.sendEvent.bind(runtime.gateway);
  runtime.gateway.sendEvent = ((instanceId: string, type: string, payload: unknown) => {
    acks.push({ type, payload });
    return original(instanceId, type, payload);
  }) as typeof runtime.gateway.sendEvent;
  const fire = (event: unknown) => runtime.gateway["deps"].onEvent!("i1", "a1", {
    protocolVersion: RELAY_PROTOCOL_VERSION, kind: "event", type: MSG.instanceEvent, payload: { event },
  });
  fire({ type: "turn-started", chatKey: "relay:a1", sessionAlias: "backend", prompt: "q" });
  fire({ type: "turn-output", chatKey: "relay:a1", sessionAlias: "backend", chunk: "answer" });
  fire({ type: "turn-finished", chatKey: "relay:a1", sessionAlias: "backend", ok: true, recoveryId: "r1" });
  expect(runtime.messages.listBySession("a1", "i1", "backend").messages.map((m) => [m.direction, m.text]))
    .toEqual([["in", "q"], ["out", "answer"]]);
  expect(acks).toEqual([{ type: MSG.instanceRecoveryAck, payload: { recoveryIds: ["r1"] } }]);
  runtime.close();
});

test("hub crash between frame receipt and SQLite commit: rows roll back, no ack, redelivery persists once", async () => {
  const { runtime, records } = await seeded();
  const acks: Array<{ type: string; payload: unknown }> = [];
  const originalSend = runtime.gateway.sendEvent.bind(runtime.gateway);
  runtime.gateway.sendEvent = ((instanceId: string, type: string, payload: unknown) => {
    acks.push({ type, payload });
    return originalSend(instanceId, type, payload);
  }) as typeof runtime.gateway.sendEvent;
  const payload = {
    turns: [], usage: [], commands: [],
    finishedOffline: [{ sessionAlias: "done", ok: true, text: "offline reply", prompt: "q", recoveryId: "r1" }],
  };

  // The connector flushed the sync frame; the hub dies while persisting, i.e. the
  // append throws INSIDE the transaction. It must roll back completely — no rows,
  // no receipt, no ack (the connector still holds the FIFO entry, so the story is
  // not over).
  const originalAppend = runtime.messages.append.bind(runtime.messages);
  runtime.messages.append = (() => { throw new Error("simulated crash before commit"); }) as typeof runtime.messages.append;
  sync(runtime, payload);
  runtime.messages.append = originalAppend;
  expect(runtime.messages.listBySession("a1", "i1", "done").messages).toEqual([]);
  expect(runtime.recoveryReceipts.has("i1", "r1")).toBe(false);
  expect(acks).toEqual([]);
  expect(records.some((r) => r.event === "relay.event.persist_failed")).toBe(true);

  // Reconnect: the connector re-sends the same snapshot; the clean persist lands
  // EXACTLY once and the hub acks the recovery id.
  sync(runtime, payload);
  expect(runtime.messages.listBySession("a1", "i1", "done").messages.map((m) => [m.direction, m.text]))
    .toEqual([["in", "q"], ["out", "offline reply"]]);
  expect(acks).toEqual([{ type: MSG.instanceRecoveryAck, payload: { recoveryIds: ["r1"] } }]);
  runtime.close();
});
