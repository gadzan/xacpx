// tests/unit/packages/relay-protocol/web-dtos.test.ts
import { expect, test } from "bun:test";
import {
  WEB_CLIENT_TYPE,
  WEB_EVENT_TYPE,
  decodeEnvelope,
  encodeEnvelope,
  parseWebClientMessage,
  parseWebServerEvent,
  webClientEnvelope,
  webEventEnvelope,
  type FsEntryDto,
  type FsListResult,
  type FsSearchHitDto,
  type FsSearchPayload,
  type FsSearchResult,
  type InstanceSummaryDto,
  type WebServerEvent,
} from "../../../../packages/relay-protocol/src/index";

test("webEventEnvelope wraps an event and round-trips through encode/decode", () => {
  const event: WebServerEvent = {
    kind: "control-event",
    instanceId: "i1",
    event: { type: "turn-output", chatKey: "relay:a1", sessionAlias: "backend", chunk: "hi" },
  };
  const wire = encodeEnvelope(webEventEnvelope(event));
  const decoded = decodeEnvelope(wire);
  expect(decoded.ok).toBe(true);
  if (!decoded.ok) return;
  expect(decoded.envelope.type).toBe(WEB_EVENT_TYPE);
  expect(parseWebServerEvent(decoded.envelope)).toEqual(event);
});

test("parseWebServerEvent rejects non-web envelopes", () => {
  expect(parseWebServerEvent({ protocolVersion: 1, kind: "event", type: "instance.event", payload: {} } as never)).toBeNull();
});

test("instance-status and notice events are representable", () => {
  const status: WebServerEvent = { kind: "instance-status", instanceId: "i1", online: false };
  const notice: WebServerEvent = { kind: "notice", instanceId: "i1", notice: { kind: "task-completion", text: "done" } };
  expect(parseWebServerEvent(decodeOk(status))).toEqual(status);
  expect(parseWebServerEvent(decodeOk(notice))).toEqual(notice);
});

function decodeOk(event: WebServerEvent) {
  const decoded = decodeEnvelope(encodeEnvelope(webEventEnvelope(event)));
  if (!decoded.ok) throw new Error("decode failed");
  return decoded.envelope;
}

test("parseWebServerEvent rejects malformed payloads", () => {
  const wrap = (payload: unknown) => ({ protocolVersion: 1, kind: "event", type: WEB_EVENT_TYPE, payload }) as never;
  expect(parseWebServerEvent(wrap(null))).toBeNull();
  expect(parseWebServerEvent(wrap("nope"))).toBeNull();
  expect(parseWebServerEvent(wrap({ kind: "future-variant", instanceId: "i1" }))).toBeNull();
  expect(parseWebServerEvent(wrap({ kind: "instance-status", instanceId: "i1" }))).toBeNull(); // missing online
  expect(parseWebServerEvent(wrap({ kind: "instance-status", online: true }))).toBeNull(); // missing instanceId
  expect(parseWebServerEvent(wrap({ kind: "control-event", instanceId: "i1", event: "x" }))).toBeNull();
  expect(parseWebServerEvent(wrap({ kind: "notice", instanceId: "i1", notice: 5 }))).toBeNull();
});

test("rejects a control-event whose inner event has an unknown type", () => {
  expect(parseWebServerEvent(webEventEnvelope({ kind: "control-event", instanceId: "i", event: { type: "__bogus__" } as never }))).toBeNull();
});

test("rejects a turn-output event missing sessionAlias/chunk", () => {
  expect(parseWebServerEvent(webEventEnvelope({ kind: "control-event", instanceId: "i", event: { type: "turn-output" } as never }))).toBeNull();
});

test("rejects a turn-finished event missing ok", () => {
  expect(parseWebServerEvent(webEventEnvelope({ kind: "control-event", instanceId: "i", event: { type: "turn-finished", chatKey: "c", sessionAlias: "s" } as never }))).toBeNull();
});

test("rejects a notice missing kind/text", () => {
  expect(parseWebServerEvent(webEventEnvelope({ kind: "notice", instanceId: "i", notice: { foo: 1 } as never }))).toBeNull();
});

test("rejects a notice with an unknown kind", () => {
  expect(parseWebServerEvent(webEventEnvelope({ kind: "notice", instanceId: "i", notice: { kind: "bad", text: "x" } as never }))).toBeNull();
});

test("accepts well-formed control-events and notices", () => {
  expect(parseWebServerEvent(webEventEnvelope({ kind: "control-event", instanceId: "i", event: { type: "turn-output", chatKey: "c", sessionAlias: "s", chunk: "x" } }))).not.toBeNull();
  expect(parseWebServerEvent(webEventEnvelope({ kind: "control-event", instanceId: "i", event: { type: "turn-finished", chatKey: "c", sessionAlias: "s", ok: true } }))).not.toBeNull();
  expect(parseWebServerEvent(webEventEnvelope({ kind: "control-event", instanceId: "i", event: { type: "sessions-changed" } }))).not.toBeNull();
  expect(parseWebServerEvent(webEventEnvelope({ kind: "control-event", instanceId: "i", event: { type: "scheduled-changed", chatKey: "c" } }))).not.toBeNull();
  expect(parseWebServerEvent(webEventEnvelope({ kind: "control-event", instanceId: "i", event: { type: "orchestration-changed" } }))).not.toBeNull();
  expect(parseWebServerEvent(webEventEnvelope({ kind: "notice", instanceId: "i", notice: { kind: "task-completion", text: "done" } }))).not.toBeNull();
});

function roundtrip(event: any) {
  return parseWebServerEvent(webEventEnvelope(event));
}

test("accepts the new turn-status control events", () => {
  expect(roundtrip({ kind: "control-event", instanceId: "i1", event: { type: "turn-started", chatKey: "c", sessionAlias: "s" } })).not.toBeNull();
  expect(roundtrip({ kind: "control-event", instanceId: "i1", event: { type: "turn-started", chatKey: "c", sessionAlias: "s", prompt: "queued", queueItemId: "q1" } })).not.toBeNull();
  expect(roundtrip({ kind: "control-event", instanceId: "i1", event: { type: "turn-started", chatKey: "c", sessionAlias: "s", queueItemId: 1 } })).toBeNull();
  expect(roundtrip({ kind: "control-event", instanceId: "i1", event: { type: "turn-thought", chatKey: "c", sessionAlias: "s", chunk: "x" } })).not.toBeNull();
  expect(roundtrip({
    kind: "control-event", instanceId: "i1",
    event: { type: "tool-event", chatKey: "c", sessionAlias: "s", step: { toolCallId: "t1", toolName: "Read", kind: "read", status: "running", title: "x" } },
  })).not.toBeNull();
});

test("rejects turn-finished fields the hub persists when they are not strings/booleans", () => {
  // errorMessage / cancelled / text / recoveryId are read straight into SQLite by the
  // hub — a buggy connector sending numbers or objects must be rejected, not trigger
  // a disconnect loop on binding failures.
  const fin = (extra: Record<string, unknown>) => ({ kind: "control-event", instanceId: "i1", event: { type: "turn-finished", chatKey: "c", sessionAlias: "s", ok: false, ...extra } });
  expect(roundtrip(fin({ errorMessage: "boom" }))).not.toBeNull();
  expect(roundtrip(fin({ errorMessage: "boom", cancelled: true }))).not.toBeNull();
  expect(roundtrip(fin({ errorMessage: 42 }))).toBeNull();
  expect(roundtrip(fin({ errorMessage: { boom: true } }))).toBeNull();
  expect(roundtrip(fin({ cancelled: "yes" }))).toBeNull();
  expect(roundtrip(fin({ text: 1 }))).toBeNull();
  expect(roundtrip(fin({ recoveryId: 7 }))).toBeNull();
});

test("validates turn-started.scheduled with the same shape as the state-sync validator", () => {
  const start = (extra: Record<string, unknown>) => ({ kind: "control-event", instanceId: "i1", event: { type: "turn-started", chatKey: "c", sessionAlias: "s", ...extra } });
  expect(roundtrip(start({ scheduled: { taskId: "t1", executeAt: "2026-06-16T09:00:00.000Z" } }))).not.toBeNull();
  expect(roundtrip(start({ scheduled: { taskId: "t1" } }))).toBeNull(); // missing executeAt
  expect(roundtrip(start({ scheduled: { executeAt: "2026-06-16T09:00:00.000Z" } }))).toBeNull(); // missing taskId
  expect(roundtrip(start({ scheduled: "oops" }))).toBeNull();
});

test("parseWebServerEvent accepts a plan control event", () => {
  expect(roundtrip({
    kind: "control-event", instanceId: "i1",
    event: { type: "plan", chatKey: "k", sessionAlias: "a", entries: [{ content: "x", status: "pending" }] },
  })).not.toBeNull();
});

test("parseWebServerEvent accepts a turn-usage control event and rejects malformed ones", () => {
  // The gate (CONTROL_EVENT_TYPES + validControlEvent) must let well-formed usage through…
  expect(roundtrip({
    kind: "control-event", instanceId: "i1",
    event: { type: "turn-usage", chatKey: "k", sessionAlias: "a", used: 34606, size: 200000 },
  })).not.toBeNull();
  // …and reject non-numeric or missing used/size, or it would crash the meter's math.
  expect(roundtrip({ kind: "control-event", instanceId: "i1", event: { type: "turn-usage", chatKey: "k", sessionAlias: "a", used: 1 } })).toBeNull();
  expect(roundtrip({ kind: "control-event", instanceId: "i1", event: { type: "turn-usage", chatKey: "k", sessionAlias: "a", used: "x", size: 200000 } })).toBeNull();
  expect(roundtrip({ kind: "control-event", instanceId: "i1", event: { type: "turn-usage", chatKey: "k", sessionAlias: "a", used: 1, size: 2, cost: { amount: "free" } } })).toBeNull();
  expect(roundtrip({ kind: "control-event", instanceId: "i1", event: { type: "turn-usage", chatKey: "k", sessionAlias: "a", used: 1, size: 2, breakdown: { inputTokens: -1 } } })).toBeNull();
});

test("parseWebServerEvent accepts a queue-updated control event and rejects malformed ones", () => {
  // The gate (CONTROL_EVENT_TYPES + validControlEvent) must let well-formed queue snapshots
  // through and preserve `items`, or the web queue strip never populates on live pushes.
  const ev = roundtrip({
    kind: "control-event", instanceId: "i1",
    event: { type: "queue-updated", chatKey: "k", sessionAlias: "a", items: [{ id: "q1", textPreview: "hi", enqueuedAt: "2026-07-01T00:00:00Z" }] },
  });
  expect(ev).not.toBeNull();
  expect((ev as Extract<WebServerEvent, { kind: "control-event" }>).event).toMatchObject({
    type: "queue-updated",
    items: [{ id: "q1", textPreview: "hi", enqueuedAt: "2026-07-01T00:00:00Z" }],
  });
  // an empty queue is valid (the "just drained to empty" snapshot)…
  expect(roundtrip({ kind: "control-event", instanceId: "i1", event: { type: "queue-updated", chatKey: "k", sessionAlias: "a", items: [] } })).not.toBeNull();
  // …but items must be an array, or the strip has nothing iterable.
  expect(roundtrip({ kind: "control-event", instanceId: "i1", event: { type: "queue-updated", chatKey: "k", sessionAlias: "a" } })).toBeNull();
  expect(roundtrip({ kind: "control-event", instanceId: "i1", event: { type: "queue-updated", chatKey: "k", sessionAlias: "a", items: "x" } })).toBeNull();
});

test("parseWebServerEvent accepts an agent-commands control event and rejects malformed ones", () => {
  expect(roundtrip({
    kind: "control-event", instanceId: "i1",
    event: { type: "agent-commands", chatKey: "k", sessionAlias: "a", commands: [{ name: "compact" }] },
  })).not.toBeNull();
  // commands must be an array, or the composer autocomplete has nothing iterable.
  expect(roundtrip({ kind: "control-event", instanceId: "i1", event: { type: "agent-commands", chatKey: "k", sessionAlias: "a" } })).toBeNull();
  expect(roundtrip({ kind: "control-event", instanceId: "i1", event: { type: "agent-commands", chatKey: "k", sessionAlias: "a", commands: "x" } })).toBeNull();
  // an empty list is valid (a legitimate "clear")…
  expect(roundtrip({ kind: "control-event", instanceId: "i1", event: { type: "agent-commands", chatKey: "k", sessionAlias: "a", commands: [] } })).not.toBeNull();
  // …but a nameless entry is rejected so the composer's `c.name` access can't crash.
  expect(roundtrip({ kind: "control-event", instanceId: "i1", event: { type: "agent-commands", chatKey: "k", sessionAlias: "a", commands: [{ description: "no name" }] } })).toBeNull();
});

test("parseWebServerEvent accepts a session-history control event and preserves its rows", () => {
  // The gate (CONTROL_EVENT_TYPES + validControlEvent) must let session-history through,
  // or recovered native-session conversations are silently dropped and the web
  // handler for them is dead code.
  const ev = roundtrip({
    kind: "control-event", instanceId: "i1",
    event: {
      type: "session-history", chatKey: "k", sessionAlias: "a",
      messages: [
        { direction: "in", text: "hello" },
        { direction: "out", text: "hi", structured: { reasoning: "r" } },
      ],
    },
  });
  expect(ev).not.toBeNull();
  expect((ev as Extract<WebServerEvent, { kind: "control-event" }>).event).toMatchObject({
    type: "session-history",
    chatKey: "k",
    sessionAlias: "a",
    messages: [
      { direction: "in", text: "hello" },
      { direction: "out", text: "hi", structured: { reasoning: "r" } },
    ],
  });
  // an empty recovery is valid (a native session with no prior rows)…
  expect(roundtrip({ kind: "control-event", instanceId: "i1", event: { type: "session-history", chatKey: "k", sessionAlias: "a", messages: [] } })).not.toBeNull();
});

test("parseWebServerEvent rejects malformed session-history events", () => {
  // messages must be an array, or the hub's seed loop has nothing iterable.
  expect(roundtrip({ kind: "control-event", instanceId: "i1", event: { type: "session-history", chatKey: "k", sessionAlias: "a" } })).toBeNull();
  expect(roundtrip({ kind: "control-event", instanceId: "i1", event: { type: "session-history", chatKey: "k", sessionAlias: "a", messages: "x" } })).toBeNull();
  // chatKey/sessionAlias must be strings (routing keys).
  expect(roundtrip({ kind: "control-event", instanceId: "i1", event: { type: "session-history", sessionAlias: "a", messages: [] } })).toBeNull();
  expect(roundtrip({ kind: "control-event", instanceId: "i1", event: { type: "session-history", chatKey: 1, sessionAlias: "a", messages: [] } })).toBeNull();
  expect(roundtrip({ kind: "control-event", instanceId: "i1", event: { type: "session-history", chatKey: "k", messages: [] } })).toBeNull();
  // per-row guards: direction must be "in"/"out" and text must be a string,
  // or the web's history seed renders junk rows from a buggy connector.
  expect(roundtrip({ kind: "control-event", instanceId: "i1", event: { type: "session-history", chatKey: "k", sessionAlias: "a", messages: [{ direction: "sideways", text: "x" }] } })).toBeNull();
  expect(roundtrip({ kind: "control-event", instanceId: "i1", event: { type: "session-history", chatKey: "k", sessionAlias: "a", messages: [{ direction: "in" }] } })).toBeNull();
});

test("parseWebServerEvent rejects a plan event without entries", () => {
  expect(roundtrip({
    kind: "control-event", instanceId: "i1",
    event: { type: "plan", chatKey: "k", sessionAlias: "a" },
  })).toBeNull();
});

test("rejects a malformed tool-event step", () => {
  expect(roundtrip({ kind: "control-event", instanceId: "i1", event: { type: "tool-event", chatKey: "c", sessionAlias: "s", step: { toolCallId: "t1" } } })).toBeNull();
});

test("accepts an error string on a failed tool-event step, rejects a non-string error", () => {
  expect(roundtrip({
    kind: "control-event", instanceId: "i1",
    event: { type: "tool-event", chatKey: "c", sessionAlias: "s", step: { toolCallId: "t1", toolName: "read", kind: "read", status: "error", title: "x", error: "File not found" } },
  })).not.toBeNull();
  expect(roundtrip({
    kind: "control-event", instanceId: "i1",
    event: { type: "tool-event", chatKey: "c", sessionAlias: "s", step: { toolCallId: "t1", toolName: "read", kind: "read", status: "error", title: "x", error: 42 } },
  })).toBeNull();
});

test("accepts an agentMessageId on a tool-event step, rejects a non-string one", () => {
  const event = (extra: Record<string, unknown>) => ({
    kind: "control-event", instanceId: "i1",
    event: {
      type: "tool-event", chatKey: "c", sessionAlias: "s",
      step: { toolCallId: "t1", toolName: "agent_send", kind: "other", status: "success", title: "x", ...extra },
    },
  });
  expect(roundtrip(event({ agentMessageId: "msg_3f2a9c1e-7b4d-4e5f-8a6b-2c1d0e9f8a7b" }))).not.toBeNull();
  expect(roundtrip(event({ agentMessageId: 42 }))).toBeNull();
});

test("accepts subagent hierarchy fields and rejects malformed hierarchy metadata", () => {
  const event = (extra: Record<string, unknown>) => ({
    kind: "control-event", instanceId: "i1",
    event: {
      type: "tool-event", chatKey: "c", sessionAlias: "s",
      step: { toolCallId: "t1", toolName: "Agent", kind: "think", status: "running", title: "Explore", ...extra },
    },
  });
  expect(roundtrip(event({ isSubagent: true }))).not.toBeNull();
  expect(roundtrip(event({ parentToolCallId: "parent-1" }))).not.toBeNull();
  expect(roundtrip(event({ isSubagent: "yes" }))).toBeNull();
  expect(roundtrip(event({ parentToolCallId: 42 }))).toBeNull();
});

test("accepts a deep-valid state snapshot and rejects mismatched or malformed rows", () => {
  const snapshot = {
    kind: "state-snapshot", instanceId: "i1",
    turns: [{
      instanceId: "i1", sessionAlias: "backend", status: "streaming", startedAt: 10,
      parts: [
        { type: "tool", step: { toolCallId: "agent-1", toolName: "Agent", kind: "think", status: "running", title: "Explore", isSubagent: true } },
        { type: "text", text: "working" },
      ],
    }],
    usage: [{ instanceId: "i1", sessionAlias: "backend", used: 10, size: 100 }],
    commands: [{ instanceId: "i1", sessionAlias: "backend", commands: [{ name: "compact" }] }],
  };
  expect(roundtrip(snapshot)).not.toBeNull();
  expect(roundtrip({ ...snapshot, turns: [{ ...snapshot.turns[0], instanceId: "i2" }] })).toBeNull();
  expect(roundtrip({ ...snapshot, turns: [{ ...snapshot.turns[0], parts: [{ type: "text", text: 42 }] }] })).toBeNull();
  expect(roundtrip({ ...snapshot, usage: "bad" })).toBeNull();
  expect(roundtrip({ ...snapshot, turns: [{ ...snapshot.turns[0], parts: [{ type: "tool", step: { ...snapshot.turns[0].parts[0].step, durationMs: -1 } }] }] })).toBeNull();
  expect(roundtrip({ ...snapshot, usage: [{ ...snapshot.usage[0], cost: { amount: "bad" } }] })).toBeNull();
  expect(roundtrip({ ...snapshot, usage: [{ ...snapshot.usage[0], breakdown: { totalTokens: -1 } }] })).toBeNull();
  expect(roundtrip({ ...snapshot, commands: [{ ...snapshot.commands[0], commands: [{ name: "compact", hasInput: "yes" }] }] })).toBeNull();
});

test("rejects a tool-event step with an unknown detail tag", () => {
  expect(roundtrip({
    kind: "control-event", instanceId: "i1",
    event: { type: "tool-event", chatKey: "c", sessionAlias: "s", step: { toolCallId: "t1", toolName: "R", kind: "read", status: "running", title: "x", detail: { type: "bogus" } } },
  })).toBeNull();
});

test("rejects a tool-event whose detail has a known tag but missing/junk inner fields", () => {
  const step = (detail: unknown) => ({
    kind: "control-event", instanceId: "i1",
    event: { type: "tool-event", chatKey: "c", sessionAlias: "s", step: { toolCallId: "t1", toolName: "R", kind: "read", status: "running", title: "x", detail } },
  });
  expect(roundtrip(step({ type: "diff", path: "a" }))).toBeNull(); // missing oldText/newText
  expect(roundtrip(step({ type: "command", command: 42 }))).toBeNull(); // command not a string
  expect(roundtrip(step({ type: "command", command: "ls", exitCode: "0" }))).toBeNull(); // exitCode not a number
  expect(roundtrip(step({ type: "search" }))).toBeNull(); // missing query
  expect(roundtrip(step({ type: "text" }))).toBeNull(); // missing text
  expect(roundtrip(step({ type: "text", text: "p", output: 42 }))).toBeNull(); // output not a string
  expect(roundtrip(step({ type: "read" }))).toBeNull(); // missing path
  expect(roundtrip(step({ type: "fields", fields: [{ label: "a" }] }))).toBeNull(); // field missing value
  expect(roundtrip(step({ type: "fields", fields: "nope" }))).toBeNull(); // fields not an array
});

test("accepts well-formed per-variant tool details", () => {
  const step = (detail: unknown) => ({
    kind: "control-event", instanceId: "i1",
    event: { type: "tool-event", chatKey: "c", sessionAlias: "s", step: { toolCallId: "t1", toolName: "R", kind: "read", status: "success", title: "x", detail } },
  });
  expect(roundtrip(step({ type: "diff", path: "a", oldText: "x", newText: "y" }))).not.toBeNull();
  expect(roundtrip(step({ type: "read", path: "a", lines: "0–10", preview: "hi" }))).not.toBeNull();
  expect(roundtrip(step({ type: "command", command: "ls", output: "f", exitCode: 0 }))).not.toBeNull();
  expect(roundtrip(step({ type: "search", query: "rg x" }))).not.toBeNull();
  expect(roundtrip(step({ type: "text", text: "thinking" }))).not.toBeNull();
  expect(roundtrip(step({ type: "text", text: "prompt", output: "the subagent report" }))).not.toBeNull();
  expect(roundtrip(step({ type: "fields", fields: [{ label: "a", value: "b" }], output: "o" }))).not.toBeNull();
});

test("fs DTOs carry the tree-browser additions", () => {
  const entry: FsEntryDto = { name: "a", type: "file", ignored: true };
  const list: FsListResult = { workspace: "w", path: "", entries: [entry], root: "/abs", sep: "/" };
  const hit: FsSearchHitDto = { path: "a.ts", line: 3, text: "x" };
  const payload: FsSearchPayload = { workspace: "w", query: "x", mode: "content", regex: true, include: "**/*.ts", path: "src" };
  const result: FsSearchResult = { workspace: "w", query: "x", matches: [], hits: [hit], truncated: false };
  expect(list.root).toBe("/abs");
  expect(list.sep).toBe("/");
  expect(payload.mode).toBe("content");
  expect(result.hits[0].line).toBe(3);
});

test("parseWebClientMessage round-trips a subscribe frame", () => {
  const wire = encodeEnvelope(webClientEnvelope({ kind: "subscribe", instanceIds: ["a", "b"] }));
  const decoded = decodeEnvelope(wire);
  expect(decoded.ok).toBe(true);
  if (!decoded.ok) return;
  expect(parseWebClientMessage(decoded.envelope)).toEqual({ kind: "subscribe", instanceIds: ["a", "b"] });
});

test("parseWebClientMessage accepts an empty subscribe set", () => {
  const wire = encodeEnvelope(webClientEnvelope({ kind: "subscribe", instanceIds: [] }));
  const decoded = decodeEnvelope(wire);
  if (!decoded.ok) throw new Error("decode failed");
  expect(parseWebClientMessage(decoded.envelope)).toEqual({ kind: "subscribe", instanceIds: [] });
});

test("parseWebClientMessage rejects subscribe with a non-array / non-string instanceIds", () => {
  const bad1 = { protocolVersion: 1, kind: "event", type: WEB_CLIENT_TYPE, payload: { kind: "subscribe", instanceIds: "nope" } } as never;
  const bad2 = { protocolVersion: 1, kind: "event", type: WEB_CLIENT_TYPE, payload: { kind: "subscribe", instanceIds: [1, 2] } } as never;
  expect(parseWebClientMessage(bad1)).toBeNull();
  expect(parseWebClientMessage(bad2)).toBeNull();
});

test("parseWebClientMessage accepts the dashboard's complete instance set and bounds instance id length", () => {
  const envelope = (instanceIds: string[]) => ({
    protocolVersion: 1, kind: "event", type: WEB_CLIENT_TYPE,
    payload: { kind: "subscribe", instanceIds },
  }) as never;
  expect(parseWebClientMessage(envelope(Array.from({ length: 256 }, (_, i) => `i${i}`)))).not.toBeNull();
  expect(parseWebClientMessage(envelope(Array.from({ length: 257 }, (_, i) => `i${i}`)))).not.toBeNull();
  expect(parseWebClientMessage(envelope(["x".repeat(128)]))).not.toBeNull();
  expect(parseWebClientMessage(envelope(["x".repeat(129)]))).toBeNull();
  expect(parseWebClientMessage(envelope([""]))).toBeNull();
});

test("parseWebClientMessage still round-trips terminal-input (regression)", () => {
  const wire = encodeEnvelope(webClientEnvelope({ kind: "terminal-input", instanceId: "i1", terminalId: "t1", data: "ls\n" }));
  const decoded = decodeEnvelope(wire);
  if (!decoded.ok) throw new Error("decode failed");
  expect(parseWebClientMessage(decoded.envelope)).toEqual({ kind: "terminal-input", instanceId: "i1", terminalId: "t1", data: "ls\n" });
});

test("InstanceSummaryDto includes optional capabilities (missing → treat as empty)", () => {
  const withCaps: InstanceSummaryDto = {
    id: "i1",
    name: "pc",
    online: true,
    lastSeenAt: null,
    capabilities: ["terminal.rmux.recovery.v1", "terminal.multi-view.v1"],
  };
  const legacy: InstanceSummaryDto = {
    id: "i2",
    name: "old",
    online: false,
    lastSeenAt: null,
  };
  expect(withCaps.capabilities).toHaveLength(2);
  expect(legacy.capabilities ?? []).toEqual([]);
});

test("validControlEvent round-trips agent-message event with structured peer details", () => {
  const event: WebServerEvent = {
    kind: "control-event",
    instanceId: "i1",
    event: {
      type: "agent-message",
      chatKey: "relay:a1",
      sessionAlias: "backend",
      message: {
        kind: "agent_message",
        direction: "sent",
        messageId: "msg_123",
        conversationId: "conv_456",
        replyTo: "msg_100",
        peer: {
          handle: "agent:node_2:worker_b",
          displayName: "Worker B",
          agent: "codex",
          workspace: "frontend",
        },
        content: "API endpoint changed to /api/v2/users",
        createdAt: 1771234567890,
        status: "sent",
      },
    },
  };
  const wire = encodeEnvelope(webEventEnvelope(event));
  const decoded = decodeEnvelope(wire);
  expect(decoded.ok).toBe(true);
  if (!decoded.ok) return;
  expect(parseWebServerEvent(decoded.envelope)).toEqual(event);
});

test("agent-directory events preserve endpoint context fields and accept legacy rows", () => {
  // endpointKind/channelId are optional presentation context (v0.3): rows from
  // new daemons carry them; rows from old daemons omit them and must parse.
  const event: WebServerEvent = {
    kind: "agent-directory",
    endpoints: [
      {
        instanceId: "i1",
        nodeId: "node_a",
        endpointId: "ep_logical",
        agent: "codex",
        state: "idle",
        capabilities: { receive: true, steer: false, queue: true, interrupt: false },
        updatedAt: 1771234567890,
        endpointKind: "logical",
        channelId: "relay",
      },
      {
        instanceId: "i1",
        nodeId: "node_a",
        endpointId: "ep_worker",
        agent: "claude",
        state: "running",
        capabilities: { receive: true, steer: false, queue: true, interrupt: false },
        updatedAt: 1771234567890,
        endpointKind: "worker",
      },
      {
        instanceId: "i1",
        nodeId: "node_old",
        endpointId: "ep_legacy",
        agent: "gemini",
        state: "idle",
        capabilities: { receive: true, steer: false, queue: true, interrupt: false },
        updatedAt: 1771234567890,
      },
    ],
  };
  const wire = encodeEnvelope(webEventEnvelope(event));
  const decoded = decodeEnvelope(wire);
  expect(decoded.ok).toBe(true);
  if (!decoded.ok) return;
  const parsed = parseWebServerEvent(decoded.envelope);
  expect(parsed).toEqual(event);
  if (!parsed || parsed.kind !== "agent-directory") return;
  expect(parsed.endpoints[0]).toMatchObject({ endpointKind: "logical", channelId: "relay" });
  expect(parsed.endpoints[1]).toMatchObject({ endpointKind: "worker" });
  expect("channelId" in parsed.endpoints[1]!).toBe(false);
  expect("endpointKind" in parsed.endpoints[2]!).toBe(false);
  expect("channelId" in parsed.endpoints[2]!).toBe(false);
});
