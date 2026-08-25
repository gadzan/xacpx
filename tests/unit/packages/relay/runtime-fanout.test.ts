// tests/unit/packages/relay/runtime-fanout.test.ts
import { expect, test } from "bun:test";
import {
  MSG, RELAY_PROTOCOL_VERSION, decodeEnvelope, parseWebServerEvent,
} from "../../../../packages/relay-protocol/src/index";
import { createRelayRuntime } from "../../../../packages/relay/src/server";
import type { RelayLogger } from "../../../../packages/relay/src/logging";

class FakeSocket {
  sent: string[] = [];
  on() { return this; }
  send(data: string) { this.sent.push(data); }
}

async function seeded() {
  const runtime = await createRelayRuntime(":memory:");
  runtime.db.run("INSERT INTO accounts (id, username, created_at) VALUES (?,?,?)", ["a1", "u", "t"]);
  runtime.db.run("INSERT INTO instances (id, account_id, name, credential_hash, created_at) VALUES (?,?,?,?,?)", ["i1", "a1", "pc", "h", "t"]);
  return runtime;
}

test("control events broadcast to web sockets and turn output is cached on finish", async () => {
  const runtime = await seeded();
  const web = new FakeSocket();
  runtime.webGateway.register("a1", web as never);

  const fire = (event: unknown) => runtime.gateway["deps"].onEvent!("i1", "a1", {
    protocolVersion: RELAY_PROTOCOL_VERSION, kind: "event", type: MSG.instanceEvent, payload: { event },
  });

  fire({ type: "turn-started", chatKey: "relay:a1", sessionAlias: "backend" });
  fire({ type: "turn-output", chatKey: "relay:a1", sessionAlias: "backend", chunk: "hel" });
  fire({ type: "turn-output", chatKey: "relay:a1", sessionAlias: "backend", chunk: "lo" });
  fire({ type: "turn-finished", chatKey: "relay:a1", sessionAlias: "backend", ok: true });

  expect(web.sent.length).toBe(4); // every event is broadcast verbatim
  const firstOutput = decodeEnvelope(web.sent[1]!);
  expect(firstOutput.ok && parseWebServerEvent(firstOutput.envelope)).toEqual({
    kind: "control-event", instanceId: "i1",
    event: { type: "turn-output", chatKey: "relay:a1", sessionAlias: "backend", chunk: "hel" },
  });

  const last = decodeEnvelope(web.sent[3]!);
  expect(last.ok && parseWebServerEvent(last.envelope)).toEqual({
    kind: "control-event", instanceId: "i1",
    event: { type: "turn-finished", chatKey: "relay:a1", sessionAlias: "backend", ok: true },
  });

  const cached = runtime.messages.listBySession("a1", "i1", "backend").messages;
  expect(cached.map((m) => [m.direction, m.text])).toEqual([["out", "hello"]]);

  runtime.close();
});

test("offline clears an in-flight turn buffer so a later finish flushes nothing", async () => {
  const runtime = await seeded();
  const fire = (event: unknown) => runtime.gateway["deps"].onEvent!("i1", "a1", {
    protocolVersion: RELAY_PROTOCOL_VERSION, kind: "event", type: MSG.instanceEvent, payload: { event },
  });
  fire({ type: "turn-output", chatKey: "relay:a1", sessionAlias: "backend", chunk: "partial" });
  runtime.gateway["deps"].onStatusChange!("i1", "a1", false);
  fire({ type: "turn-finished", chatKey: "relay:a1", sessionAlias: "backend", ok: true });
  expect(runtime.messages.listBySession("a1", "i1", "backend").messages).toEqual([]);
  runtime.close();
});

test("a stray streaming event after offline does not resurrect a leaking buffer", async () => {
  const runtime = await seeded();
  const fire = (event: unknown) => runtime.gateway["deps"].onEvent!("i1", "a1", {
    protocolVersion: RELAY_PROTOCOL_VERSION, kind: "event", type: MSG.instanceEvent, payload: { event },
  });
  fire({ type: "turn-started", chatKey: "relay:a1", sessionAlias: "backend" });
  runtime.gateway["deps"].onStatusChange!("i1", "a1", false); // sweeps the buffer
  // A late event arrives with no turn-started before it: it must be dropped, not
  // re-create a buffer. Otherwise a turn-finished that never comes would leak it.
  fire({ type: "turn-output", chatKey: "relay:a1", sessionAlias: "backend", chunk: "stray" });
  fire({ type: "tool-event", chatKey: "relay:a1", sessionAlias: "backend", step: { toolCallId: "t1", toolName: "Read", kind: "read", status: "success", title: "a.ts" } });
  fire({ type: "turn-finished", chatKey: "relay:a1", sessionAlias: "backend", ok: true });
  // Nothing persisted: the resurrected buffer would have flushed "stray"/a tool step.
  expect(runtime.messages.listBySession("a1", "i1", "backend").messages).toEqual([]);
  runtime.close();
});

test("status changes broadcast instance-status events", async () => {
  const runtime = await seeded();
  const web = new FakeSocket();
  runtime.webGateway.register("a1", web as never);
  runtime.gateway["deps"].onStatusChange!("i1", "a1", false);
  const decoded = decodeEnvelope(web.sent[0]!);
  expect(decoded.ok && parseWebServerEvent(decoded.envelope)).toEqual({ kind: "instance-status", instanceId: "i1", online: false });
  runtime.close();
});

test("accumulates tool steps + reasoning and persists structured on finish", async () => {
  const runtime = await seeded();
  const fire = (event: unknown) => runtime.gateway["deps"].onEvent!("i1", "a1", {
    protocolVersion: RELAY_PROTOCOL_VERSION, kind: "event", type: MSG.instanceEvent, payload: { event },
  });

  fire({ type: "turn-started", chatKey: "relay:a1", sessionAlias: "backend" });
  fire({ type: "tool-event", chatKey: "relay:a1", sessionAlias: "backend", step: { toolCallId: "t1", toolName: "Bash", kind: "execute", status: "running", title: "ls" } });
  fire({ type: "tool-event", chatKey: "relay:a1", sessionAlias: "backend", step: { toolCallId: "t1", toolName: "Bash", kind: "execute", status: "success", title: "ls", durationMs: 5 } });
  fire({ type: "turn-thought", chatKey: "relay:a1", sessionAlias: "backend", chunk: "think " });
  fire({ type: "turn-thought", chatKey: "relay:a1", sessionAlias: "backend", chunk: "more" });
  fire({ type: "turn-output", chatKey: "relay:a1", sessionAlias: "backend", chunk: "done" });
  fire({ type: "turn-finished", chatKey: "relay:a1", sessionAlias: "backend", ok: true });

  const cached = runtime.messages.listBySession("a1", "i1", "backend").messages;
  expect(cached.length).toBe(1);
  expect(cached[0].text).toBe("done");
  expect(cached[0].structured?.reasoning).toBe("think more");
  expect(cached[0].structured?.toolSteps).toEqual([{ toolCallId: "t1", toolName: "Bash", kind: "execute", status: "success", title: "ls", durationMs: 5 }]);
  // Ordered transcript preserved for inline replay: tool (updated in place) → reasoning → text.
  expect(cached[0].structured?.parts).toEqual([
    { type: "tool", step: { toolCallId: "t1", toolName: "Bash", kind: "execute", status: "success", title: "ls", durationMs: 5 } },
    { type: "reasoning", text: "think more" },
    { type: "text", text: "done" },
  ]);
  runtime.close();
});

test("a scheduled-origin turn-started persists the inbound prompt with its schedule origin", async () => {
  const runtime = await seeded();
  const fire = (event: unknown) => runtime.gateway["deps"].onEvent!("i1", "a1", {
    protocolVersion: RELAY_PROTOCOL_VERSION, kind: "event", type: MSG.instanceEvent, payload: { event },
  });
  // A fired scheduled task starts a turn carrying its prompt + origin; the agent reply
  // streams as usual. Both the inbound prompt and the outbound reply must persist so the
  // run shows in history (not just an out-of-context answer).
  fire({ type: "turn-started", chatKey: "relay:a1", sessionAlias: "backend", prompt: "summarize commits", scheduled: { taskId: "ab12", executeAt: "2026-06-16T09:00:00.000Z" } });
  fire({ type: "turn-output", chatKey: "relay:a1", sessionAlias: "backend", chunk: "Here you go" });
  fire({ type: "turn-finished", chatKey: "relay:a1", sessionAlias: "backend", ok: true });

  const cached = runtime.messages.listBySession("a1", "i1", "backend").messages;
  expect(cached.map((m) => [m.direction, m.text])).toEqual([["in", "summarize commits"], ["out", "Here you go"]]);
  expect(cached[0].structured?.scheduled).toEqual({ taskId: "ab12", executeAt: "2026-06-16T09:00:00.000Z" });
  runtime.close();
});

test("session-history seeds a native session's recovered conversation once (idempotent)", async () => {
  const runtime = await seeded();
  const fire = (event: unknown) => runtime.gateway["deps"].onEvent!("i1", "a1", {
    protocolVersion: RELAY_PROTOCOL_VERSION, kind: "event", type: MSG.instanceEvent, payload: { event },
  });
  const seed = {
    type: "session-history", chatKey: "relay:a1", sessionAlias: "native1",
    messages: [
      { direction: "in", text: "old question" },
      { direction: "out", text: "old answer", structured: { toolSteps: [{ toolCallId: "t1", toolName: "Read", kind: "read", status: "success", title: "a.ts" }], parts: [{ type: "text", text: "old answer" }] } },
    ],
  };
  fire(seed);
  let cached = runtime.messages.listBySession("a1", "i1", "native1").messages;
  expect(cached.map((m) => [m.direction, m.text])).toEqual([["in", "old question"], ["out", "old answer"]]);
  expect(cached[1].structured?.toolSteps?.[0]?.toolCallId).toBe("t1");

  // Re-delivery must NOT duplicate the backlog (guarded on an already-populated session).
  fire(seed);
  cached = runtime.messages.listBySession("a1", "i1", "native1").messages;
  expect(cached.length).toBe(2);
  runtime.close();
});

test("a throwing DB write during onEvent logs relay.event.persist_failed with instanceId and error", async () => {
  const logs: Array<[string, string, Record<string, unknown> | undefined]> = [];
  const logger: RelayLogger = {
    debug: (e, m, c) => logs.push([e, m, c]),
    info: (e, m, c) => logs.push([e, m, c]),
    warn: (e, m, c) => logs.push([e, m, c]),
    error: (e, m, c) => logs.push([e, m, c]),
  };
  const runtime = await createRelayRuntime(":memory:", { logger });
  runtime.db.run("INSERT INTO accounts (id, username, created_at) VALUES (?,?,?)", ["a1", "u", "t"]);
  runtime.db.run("INSERT INTO instances (id, account_id, name, credential_hash, created_at) VALUES (?,?,?,?,?)", ["i1", "a1", "pc", "h", "t"]);
  runtime.messages.append = () => { throw new Error("db boom"); };

  const fire = (event: unknown) => runtime.gateway["deps"].onEvent!("i1", "a1", {
    protocolVersion: RELAY_PROTOCOL_VERSION, kind: "event", type: MSG.instanceEvent, payload: { event },
  });

  expect(() => fire({ type: "turn-started", chatKey: "relay:a1", sessionAlias: "backend", prompt: "hi" })).not.toThrow();

  const failed = logs.find(([e]) => e === "relay.event.persist_failed");
  expect(failed).toBeDefined();
  expect(failed?.[2]).toEqual({ instanceId: "i1", error: "Error: db boom" });
  runtime.close();
});

test("boundary B: a malformed control event is dropped, not broadcast or persisted", async () => {
  const runtime = await seeded();
  const web = new FakeSocket();
  runtime.webGateway.register("a1", web as never);
  const fire = (event: unknown) => runtime.gateway["deps"].onEvent!("i1", "a1", {
    protocolVersion: RELAY_PROTOCOL_VERSION, kind: "event", type: MSG.instanceEvent, payload: { event },
  });

  // turn-finished missing the required `sessionAlias` (and `ok`) → invalid shape.
  fire({ type: "turn-finished", chatKey: "relay:a1" });

  expect(web.sent.length).toBe(0); // not broadcast
  const history = runtime.messages.listBySession("a1", "i1", "backend", { limit: 10 });
  expect(history.messages.length).toBe(0); // not persisted
  runtime.close();
});

test("a finish with no text but with tool steps still persists a structured turn", async () => {
  const runtime = await seeded();
  const fire = (event: unknown) => runtime.gateway["deps"].onEvent!("i1", "a1", {
    protocolVersion: RELAY_PROTOCOL_VERSION, kind: "event", type: MSG.instanceEvent, payload: { event },
  });
  fire({ type: "turn-started", chatKey: "relay:a1", sessionAlias: "backend" });
  fire({ type: "tool-event", chatKey: "relay:a1", sessionAlias: "backend", step: { toolCallId: "t1", toolName: "Read", kind: "read", status: "success", title: "a.ts" } });
  fire({ type: "turn-finished", chatKey: "relay:a1", sessionAlias: "backend", ok: true });
  const cached = runtime.messages.listBySession("a1", "i1", "backend").messages;
  expect(cached.length).toBe(1);
  expect(cached[0].structured?.toolSteps.length).toBe(1);
  runtime.close();
});

test("a finish with no buffer but text persists the reply (hub restarted mid-turn)", async () => {
  const runtime = await seeded();
  const fire = (event: unknown) => runtime.gateway["deps"].onEvent!("i1", "a1", {
    protocolVersion: RELAY_PROTOCOL_VERSION, kind: "event", type: MSG.instanceEvent, payload: { event },
  });
  // The turn was running across a hub restart: turn-started's buffer died with the old
  // process, so this finish arrives with no buffer. The daemon's carried reply text is
  // the hub's last chance to close the history gap — persist it as a plain out row.
  fire({ type: "turn-finished", chatKey: "relay:a1", sessionAlias: "backend", ok: true, text: "late answer" });
  const cached = runtime.messages.listBySession("a1", "i1", "backend").messages;
  expect(cached.map((m) => [m.direction, m.text])).toEqual([["out", "late answer"]]);
  expect(cached[0].structured).toBeUndefined(); // no chunks/steps buffered — nothing structured
  runtime.close();
});

test("a finish with no buffer and no text persists no row and logs a warning", async () => {
  const logs: Array<[string, string, string, Record<string, unknown> | undefined]> = [];
  const logger: RelayLogger = {
    debug: (e, m, c) => logs.push(["debug", e, m, c]),
    info: (e, m, c) => logs.push(["info", e, m, c]),
    warn: (e, m, c) => logs.push(["warn", e, m, c]),
    error: (e, m, c) => logs.push(["error", e, m, c]),
  };
  const runtime = await createRelayRuntime(":memory:", { logger });
  runtime.db.run("INSERT INTO accounts (id, username, created_at) VALUES (?,?,?)", ["a1", "u", "t"]);
  runtime.db.run("INSERT INTO instances (id, account_id, name, credential_hash, created_at) VALUES (?,?,?,?,?)", ["i1", "a1", "pc", "h", "t"]);
  const fire = (event: unknown) => runtime.gateway["deps"].onEvent!("i1", "a1", {
    protocolVersion: RELAY_PROTOCOL_VERSION, kind: "event", type: MSG.instanceEvent, payload: { event },
  });
  // Old daemon (no `text`) finishing a turn whose buffer died with the hub: never
  // fabricate an empty transcript entry, but surface the loss in the log.
  fire({ type: "turn-finished", chatKey: "relay:a1", sessionAlias: "backend", ok: true });
  expect(runtime.messages.listBySession("a1", "i1", "backend").messages).toEqual([]);
  const warned = logs.find(([, e]) => e === "relay.event.turn_finished_without_content");
  expect(warned).toBeDefined();
  expect(warned?.[0]).toBe("warn");
  expect(warned?.[3]).toEqual({ instanceId: "i1", sessionAlias: "backend" });
  runtime.close();
});

test("a finish with no buffer and empty-string text persists an empty reply row", async () => {
  const runtime = await seeded();
  const fire = (event: unknown) => runtime.gateway["deps"].onEvent!("i1", "a1", {
    protocolVersion: RELAY_PROTOCOL_VERSION, kind: "event", type: MSG.instanceEvent, payload: { event },
  });
  // Presence semantics: `text: ""` is a carried reply, not a missing one — it must
  // land as its own out row rather than being misread as "no content".
  fire({ type: "turn-finished", chatKey: "relay:a1", sessionAlias: "backend", ok: true, text: "" });
  expect(runtime.messages.listBySession("a1", "i1", "backend").messages.map((m) => [m.direction, m.text]))
    .toEqual([["out", ""]]);
  runtime.close();
});

test("task-completion notice fans out to push; other kinds do not", async () => {
  const runtime = await createRelayRuntime(":memory:", {
    vapid: { subject: "mailto:test@example.com", publicKey: "BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U", privateKey: "w7gAGvS_Do-fQS4qrv63qkIsaqw6ni5nyJoh3ud-BRU" },
  });
  runtime.db.run("INSERT INTO accounts (id, username, created_at) VALUES (?,?,?)", ["a1", "u", "t"]);
  runtime.db.run("INSERT INTO instances (id, account_id, name, credential_hash, created_at) VALUES (?,?,?,?,?)", ["i1", "a1", "pc", "h", "t"]);
  runtime.pushSubscriptions.upsert({ accountId: "a1", endpoint: "https://push/e1", p256dh: "k", auth: "a" });

  const sent: Array<{ endpoint: string; payload: string }> = [];
  (runtime.pushNotifier as unknown as { _setWebPushForTests(w: unknown): void })._setWebPushForTests({
    setVapidDetails: () => {},
    sendNotification: async (sub: { endpoint: string }, payload: string) => {
      sent.push({ endpoint: sub.endpoint, payload });
    },
  });

  const notice = (payload: unknown) => runtime.gateway["deps"].onEvent!("i1", "a1", {
    protocolVersion: RELAY_PROTOCOL_VERSION, kind: "event", type: MSG.instanceNotice, payload,
  });

  notice({ kind: "task-completion", text: "all done", taskId: "t1" });
  await new Promise((r) => setTimeout(r, 10)); // fire-and-forget fan-out
  expect(sent).toHaveLength(1);
  expect(JSON.parse(sent[0]!.payload)).toEqual({ title: "pc", body: "all done", instanceId: "i1", url: "/" });

  notice({ kind: "task-progress", text: "halfway" });
  await new Promise((r) => setTimeout(r, 10));
  expect(sent).toHaveLength(1); // progress never pushes

  runtime.close();
});
