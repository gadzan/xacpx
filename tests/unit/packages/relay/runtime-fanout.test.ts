// tests/unit/packages/relay/runtime-fanout.test.ts
import { expect, test } from "bun:test";
import {
  MSG, RELAY_PROTOCOL_VERSION, decodeEnvelope, parseWebServerEvent,
} from "../../../../packages/relay-protocol/src/index";
import { createRelayRuntime } from "../../../../packages/relay/src/server";

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

  const cached = runtime.messages.listBySession("a1", "i1", "backend");
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
  expect(runtime.messages.listBySession("a1", "i1", "backend")).toEqual([]);
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
  expect(runtime.messages.listBySession("a1", "i1", "backend")).toEqual([]);
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

  const cached = runtime.messages.listBySession("a1", "i1", "backend");
  expect(cached.length).toBe(1);
  expect(cached[0].text).toBe("done");
  expect(cached[0].structured?.reasoning).toBe("think more");
  expect(cached[0].structured?.toolSteps).toEqual([{ toolCallId: "t1", toolName: "Bash", kind: "execute", status: "success", title: "ls", durationMs: 5 }]);
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
  const cached = runtime.messages.listBySession("a1", "i1", "backend");
  expect(cached.length).toBe(1);
  expect(cached[0].structured?.toolSteps.length).toBe(1);
  runtime.close();
});
