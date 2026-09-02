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
  expect(typeof cached[0].startedAt).toBe("number");
  expect(typeof cached[0].slotAfterId).toBe("number");
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

test("a silent finish with no buffer and no text persists no row", async () => {
  const runtime = await seeded();
  const fire = (event: unknown) => runtime.gateway["deps"].onEvent!("i1", "a1", {
    protocolVersion: RELAY_PROTOCOL_VERSION, kind: "event", type: MSG.instanceEvent, payload: { event },
  });
  fire({ type: "turn-finished", chatKey: "relay:a1", sessionAlias: "backend", ok: true, silent: true });
  expect(runtime.messages.listBySession("a1", "i1", "backend").messages).toEqual([]);
  runtime.close();
});

test("a silent finish with streamed buffer text persists the streamed reply only", async () => {
  const runtime = await seeded();
  const fire = (event: unknown) => runtime.gateway["deps"].onEvent!("i1", "a1", {
    protocolVersion: RELAY_PROTOCOL_VERSION, kind: "event", type: MSG.instanceEvent, payload: { event },
  });
  fire({ type: "turn-started", chatKey: "relay:a1", sessionAlias: "backend" });
  fire({ type: "turn-output", chatKey: "relay:a1", sessionAlias: "backend", chunk: "partial" });
  fire({ type: "turn-finished", chatKey: "relay:a1", sessionAlias: "backend", ok: true, silent: true, text: "partial" });
  expect(runtime.messages.listBySession("a1", "i1", "backend").messages.map((m) => [m.direction, m.text]))
    .toEqual([["out", "partial"]]);
  runtime.close();
});

test("a silent buffered finish with no streamed text persists no out row", async () => {
  const runtime = await seeded();
  const fire = (event: unknown) => runtime.gateway["deps"].onEvent!("i1", "a1", {
    protocolVersion: RELAY_PROTOCOL_VERSION, kind: "event", type: MSG.instanceEvent, payload: { event },
  });
  fire({ type: "turn-started", chatKey: "relay:a1", sessionAlias: "backend" });
  fire({ type: "turn-finished", chatKey: "relay:a1", sessionAlias: "backend", ok: true, silent: true });
  expect(runtime.messages.listBySession("a1", "i1", "backend").messages).toEqual([]);
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

  notice({ kind: "queue-overflow", text: "Reply was truncated for size — you can continue." });
  await new Promise((r) => setTimeout(r, 10));
  expect(sent).toHaveLength(1); // overflow tips never push

  runtime.close();
});

async function setupPushRuntime(opts?: { now?: () => Date }) {
  const runtime = await createRelayRuntime(":memory:", {
    vapid: {
      subject: "mailto:test@example.com",
      publicKey: "BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U",
      privateKey: "w7gAGvS_Do-fQS4qrv63qkIsaqw6ni5nyJoh3ud-BRU",
    },
    ...(opts?.now ? { now: opts.now } : {}),
  });
  runtime.db.run("INSERT INTO accounts (id, username, created_at) VALUES (?,?,?)", ["a1", "u", "t"]);
  runtime.db.run("INSERT INTO instances (id, account_id, name, credential_hash, created_at) VALUES (?,?,?,?,?)", ["i1", "a1", "MacBook", "h", "t"]);
  runtime.pushSubscriptions.upsert({ accountId: "a1", endpoint: "https://push/e1", p256dh: "k", auth: "a" });

  const sent: Array<{ endpoint: string; payload: string }> = [];
  (runtime.pushNotifier as unknown as { _setWebPushForTests(w: unknown): void })._setWebPushForTests({
    setVapidDetails: () => {},
    sendNotification: async (sub: { endpoint: string }, payload: string) => {
      sent.push({ endpoint: sub.endpoint, payload });
    },
  });

  const { token: loginToken } = runtime.accounts.createLoginToken("a1", "test");
  const loginRes = await runtime.app.request("/api/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: loginToken }),
  });
  const cookie = loginRes.headers.get("set-cookie")?.split(";")[0] ?? "";
  const fire = (event: unknown) => runtime.gateway["deps"].onEvent!("i1", "a1", {
    protocolVersion: RELAY_PROTOCOL_VERSION, kind: "event", type: MSG.instanceEvent, payload: { event },
  });

  const notice = (payload: unknown) => runtime.gateway["deps"].onEvent!("i1", "a1", {
    protocolVersion: RELAY_PROTOCOL_VERSION, kind: "event", type: MSG.instanceNotice, payload,
  });

  const web = new FakeSocket();
  runtime.webGateway.register("a1", web as never);

  return { runtime, sent, cookie, fire, notice, web };
}
test("Gate 1: ordinary relay-web prompt completion fans out exactly 1 push with custom title and body", async () => {
  const { runtime, sent, cookie, fire, web } = await setupPushRuntime();

  let forwardedPromptRequestId: string | undefined;
  (runtime.gateway as unknown as { sendRequest: unknown }).sendRequest = async (_instanceId: string, _type: string, payload: unknown) => {
    forwardedPromptRequestId = (payload as { promptRequestId?: string }).promptRequestId;
    return { ok: true };
  };

  const rpcPromise = runtime.app.request("/api/instances/i1/rpc", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ type: MSG.prompt, payload: { sessionAlias: "backend", text: "fix bug" } }),
  });
  const res = await rpcPromise;
  expect(res.status).toBe(200);
  expect(forwardedPromptRequestId).toBeString();

  fire({ type: "turn-started", chatKey: "relay:a1", sessionAlias: "backend", promptRequestId: forwardedPromptRequestId });
  fire({ type: "turn-output", chatKey: "relay:a1", sessionAlias: "backend", chunk: "bug fixed" });
  fire({ type: "turn-finished", chatKey: "relay:a1", sessionAlias: "backend", ok: true });

  await new Promise((r) => setTimeout(r, 10));
  expect(sent).toHaveLength(1);
  expect(JSON.parse(sent[0]!.payload)).toEqual({
    title: "MacBook · backend",
    body: "bug fixed",
    instanceId: "i1",
    sessionAlias: "backend",
    url: "/",
  });

  const webCompletions = web.sent
    .map((raw) => decodeEnvelope(raw))
    .filter((d) => d.ok)
    .map((d) => parseWebServerEvent(d.envelope))
    .filter((e) => e?.kind === "turn-completion");
  expect(webCompletions).toHaveLength(1);
  expect(webCompletions[0]).toMatchObject({
    kind: "turn-completion",
    instanceId: "i1",
    sessionAlias: "backend",
    text: "bug fixed",
    ok: true,
  });
  runtime.close();
});
test("Gate 2: turn-finished without prompt provenance triggers 0 pushes", async () => {
  const { runtime, sent, fire } = await setupPushRuntime();

  fire({ type: "turn-started", chatKey: "relay:a1", sessionAlias: "backend" });
  fire({ type: "turn-output", chatKey: "relay:a1", sessionAlias: "backend", chunk: "done" });
  fire({ type: "turn-finished", chatKey: "relay:a1", sessionAlias: "backend", ok: true });

  await new Promise((r) => setTimeout(r, 10));
  expect(sent).toHaveLength(0);
  runtime.close();
});

test("connector sending MSG.instanceNotice(kind='turn-completion') is rejected and never broadcast as turn-completion", async () => {
  const { runtime, sent, notice, web } = await setupPushRuntime();

  notice({ kind: "turn-completion", text: "spoofed completion", sessionAlias: "backend", ok: true });
  await new Promise((r) => setTimeout(r, 10));

  expect(sent).toHaveLength(0);
  const webCompletions = web.sent
    .map((raw) => decodeEnvelope(raw))
    .filter((d) => d.ok)
    .map((d) => parseWebServerEvent(d.envelope))
    .filter((e) => e?.kind === "turn-completion");
  expect(webCompletions).toHaveLength(0);
  runtime.close();
});

test("Gate 3: orchestration task completion sends task push without duplicate ordinary turn push", async () => {
  const { runtime, sent, fire, notice } = await setupPushRuntime();

  fire({ type: "turn-started", chatKey: "relay:a1", sessionAlias: "orch-worker" });
  fire({ type: "turn-output", chatKey: "relay:a1", sessionAlias: "orch-worker", chunk: "subtask done" });
  fire({ type: "turn-finished", chatKey: "relay:a1", sessionAlias: "orch-worker", ok: true });

  await new Promise((r) => setTimeout(r, 10));
  expect(sent).toHaveLength(0);

  notice({ kind: "task-completion", text: "orchestration finished", taskId: "t1" });
  await new Promise((r) => setTimeout(r, 10));
  expect(sent).toHaveLength(1);
  expect(JSON.parse(sent[0]!.payload)).toEqual({
    title: "MacBook",
    body: "orchestration finished",
    instanceId: "i1",
    url: "/",
  });
  runtime.close();
});

test("Gate 4: scheduled turn-started with matching web provenance triggers 0 ordinary pushes", async () => {
  const { runtime, sent, cookie, fire } = await setupPushRuntime();

  let registeredId: string | undefined;
  (runtime.gateway as unknown as { sendRequest: unknown }).sendRequest = async (_instanceId: string, _type: string, payload: unknown) => {
    registeredId = (payload as { promptRequestId?: string }).promptRequestId;
    return { ok: true };
  };

  const res = await runtime.app.request("/api/instances/i1/rpc", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ type: MSG.prompt, payload: { sessionAlias: "backend", text: "scheduled task" } }),
  });
  expect(res.status).toBe(200);
  expect(registeredId).toBeString();
  expect(runtime.pendingWebPromptsCount?.()).toBe(1);

  fire({
    type: "turn-started",
    chatKey: "relay:a1",
    sessionAlias: "backend",
    promptRequestId: registeredId,
    scheduled: { taskId: "task1", executeAt: new Date().toISOString() },
  });
  expect(runtime.pendingWebPromptsCount?.()).toBe(0);
  fire({ type: "turn-output", chatKey: "relay:a1", sessionAlias: "backend", chunk: "scheduled result" });
  fire({ type: "turn-finished", chatKey: "relay:a1", sessionAlias: "backend", ok: true });

  await new Promise((r) => setTimeout(r, 10));
  expect(sent).toHaveLength(0);
  runtime.close();
});

test("Gate 5: peer turn-started with matching web provenance triggers 0 pushes", async () => {
  const { runtime, sent, cookie, fire } = await setupPushRuntime();

  let registeredId: string | undefined;
  (runtime.gateway as unknown as { sendRequest: unknown }).sendRequest = async (_instanceId: string, _type: string, payload: unknown) => {
    registeredId = (payload as { promptRequestId?: string }).promptRequestId;
    return { ok: true };
  };

  const res = await runtime.app.request("/api/instances/i1/rpc", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ type: MSG.prompt, payload: { sessionAlias: "backend", text: "peer task" } }),
  });
  expect(res.status).toBe(200);
  expect(registeredId).toBeString();
  expect(runtime.pendingWebPromptsCount?.()).toBe(1);

  const peerOrigin = {
    requestMessageId: "msg-1",
    completion: "result" as const,
    source: { nodeId: "node-1", endpointId: "ep-1" },
    target: { nodeId: "node-2", endpointId: "ep-2" },
  };
  fire({
    type: "turn-started",
    chatKey: "relay:a1",
    sessionAlias: "backend",
    promptRequestId: registeredId,
    peerOrigin,
  });
  expect(runtime.pendingWebPromptsCount?.()).toBe(0);
  fire({ type: "turn-output", chatKey: "relay:a1", sessionAlias: "backend", chunk: "peer result" });
  fire({ type: "turn-finished", chatKey: "relay:a1", sessionAlias: "backend", ok: true, peerOrigin });

  await new Promise((r) => setTimeout(r, 10));
  expect(sent).toHaveLength(0);
  runtime.close();
});

test("Gate 6: cancelled turn-finished triggers 0 pushes", async () => {
  const { runtime, sent, cookie, fire } = await setupPushRuntime();

  let reqId: string | undefined;
  (runtime.gateway as unknown as { sendRequest: unknown }).sendRequest = async (_instanceId: string, _type: string, payload: unknown) => {
    reqId = (payload as { promptRequestId?: string }).promptRequestId;
    return { ok: true };
  };

  await runtime.app.request("/api/instances/i1/rpc", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ type: MSG.prompt, payload: { sessionAlias: "backend", text: "cancel me" } }),
  });

  fire({ type: "turn-started", chatKey: "relay:a1", sessionAlias: "backend", promptRequestId: reqId });
  fire({ type: "turn-output", chatKey: "relay:a1", sessionAlias: "backend", chunk: "partial" });
  fire({ type: "turn-finished", chatKey: "relay:a1", sessionAlias: "backend", ok: false, cancelled: true });

  await new Promise((r) => setTimeout(r, 10));
  expect(sent).toHaveLength(0);
  runtime.close();
});

test("Gate 7: failed turn-finished triggers 1 failure push", async () => {
  const { runtime, sent, cookie, fire } = await setupPushRuntime();

  let reqId: string | undefined;
  (runtime.gateway as unknown as { sendRequest: unknown }).sendRequest = async (_instanceId: string, _type: string, payload: unknown) => {
    reqId = (payload as { promptRequestId?: string }).promptRequestId;
    return { ok: true };
  };

  await runtime.app.request("/api/instances/i1/rpc", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ type: MSG.prompt, payload: { sessionAlias: "backend", text: "fail task" } }),
  });

  fire({ type: "turn-started", chatKey: "relay:a1", sessionAlias: "backend", promptRequestId: reqId });
  fire({ type: "turn-finished", chatKey: "relay:a1", sessionAlias: "backend", ok: false, errorMessage: "provider unavailable" });

  await new Promise((r) => setTimeout(r, 10));
  expect(sent).toHaveLength(1);
  expect(JSON.parse(sent[0]!.payload)).toEqual({
    title: "MacBook · backend",
    body: "Task failed: provider unavailable",
    instanceId: "i1",
    sessionAlias: "backend",
    url: "/",
  });
  runtime.close();
});

test("Gate 8: queued prompt pushes only when drained turn actually finishes", async () => {
  const { runtime, sent, cookie, fire } = await setupPushRuntime();

  let bReqId: string | undefined;
  (runtime.gateway as unknown as { sendRequest: unknown }).sendRequest = async (_instanceId: string, _type: string, payload: unknown) => {
    bReqId = (payload as { promptRequestId?: string }).promptRequestId;
    return { ok: true, queued: true, queueItemId: "q1" };
  };

  const resB = await runtime.app.request("/api/instances/i1/rpc", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ type: MSG.prompt, payload: { sessionAlias: "backend", text: "prompt B" } }),
  });
  expect(resB.status).toBe(200);
  expect(bReqId).toBeString();

  await new Promise((r) => setTimeout(r, 10));
  expect(sent).toHaveLength(0);

  // A finishes (A had no web provenance)
  fire({ type: "turn-finished", chatKey: "relay:a1", sessionAlias: "backend", ok: true });
  await new Promise((r) => setTimeout(r, 10));
  expect(sent).toHaveLength(0);

  // B drains and starts
  fire({
    type: "turn-started",
    chatKey: "relay:a1",
    sessionAlias: "backend",
    queueItemId: "q1",
    promptRequestId: bReqId,
    prompt: "prompt B",
  });
  fire({ type: "turn-output", chatKey: "relay:a1", sessionAlias: "backend", chunk: "B complete" });
  fire({ type: "turn-finished", chatKey: "relay:a1", sessionAlias: "backend", ok: true });

  await new Promise((r) => setTimeout(r, 10));
  expect(sent).toHaveLength(1);
  expect(JSON.parse(sent[0]!.payload)).toEqual({
    title: "MacBook · backend",
    body: "B complete",
    instanceId: "i1",
    sessionAlias: "backend",
    url: "/",
  });
  runtime.close();
});

test("Gate 9: queueCancel RPC cleans up pending provenance and produces 0 pushes", async () => {
  const { runtime, sent, cookie, fire } = await setupPushRuntime();

  let bReqId: string | undefined;
  (runtime.gateway as unknown as { sendRequest: unknown }).sendRequest = async (_instanceId: string, type: string, payload: unknown) => {
    if (type === MSG.prompt) {
      bReqId = (payload as { promptRequestId?: string }).promptRequestId;
      return { ok: true, queued: true, queueItemId: "q1" };
    }
    if (type === MSG.queueCancel) {
      return { ok: true, cancelled: true };
    }
    return { ok: true };
  };

  const resPrompt = await runtime.app.request("/api/instances/i1/rpc", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ type: MSG.prompt, payload: { sessionAlias: "backend", text: "will cancel" } }),
  });
  expect(resPrompt.status).toBe(200);
  expect(bReqId).toBeString();
  expect(runtime.pendingWebPromptsCount?.()).toBe(1);

  const resCancel = await runtime.app.request("/api/instances/i1/rpc", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ type: MSG.queueCancel, payload: { sessionAlias: "backend", itemId: "q1" } }),
  });
  expect(resCancel.status).toBe(200);
  expect(runtime.pendingWebPromptsCount?.()).toBe(0);

  // If turn-finished of prior turn arrives, 0 push
  fire({ type: "turn-finished", chatKey: "relay:a1", sessionAlias: "backend", ok: true });
  await new Promise((r) => setTimeout(r, 10));
  expect(sent).toHaveLength(0);
  runtime.close();
});

test("prompt business rejection (e.g. queue-full) cleans up pending provenance immediately", async () => {
  const { runtime, cookie } = await setupPushRuntime();

  let registeredId: string | undefined;
  (runtime.gateway as unknown as { sendRequest: unknown }).sendRequest = async (_instanceId: string, _type: string, payload: unknown) => {
    registeredId = (payload as { promptRequestId?: string }).promptRequestId;
    return { ok: false, errorMessage: "queue-full" };
  };

  const res = await runtime.app.request("/api/instances/i1/rpc", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ type: MSG.prompt, payload: { sessionAlias: "backend", text: "overflow task" } }),
  });
  expect(res.status).toBe(200);
  expect(registeredId).toBeString();
  expect(runtime.pendingWebPromptsCount?.()).toBe(0);
  runtime.close();
});

test("Gate 10: finish without live TurnAccumulator produces 0 push", async () => {
  const { runtime, sent, fire } = await setupPushRuntime();

  fire({
    type: "turn-finished",
    chatKey: "relay:a1",
    sessionAlias: "backend",
    text: "finished while hub down",
    ok: true,
  });

  await new Promise((r) => setTimeout(r, 10));
  expect(sent).toHaveLength(0);
  runtime.close();
});

test("Gate 11: duplicate turn-finished produces exactly 1 push", async () => {
  const { runtime, sent, cookie, fire } = await setupPushRuntime();

  let reqId: string | undefined;
  (runtime.gateway as unknown as { sendRequest: unknown }).sendRequest = async (_instanceId: string, _type: string, payload: unknown) => {
    reqId = (payload as { promptRequestId?: string }).promptRequestId;
    return { ok: true };
  };

  await runtime.app.request("/api/instances/i1/rpc", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ type: MSG.prompt, payload: { sessionAlias: "backend", text: "hi" } }),
  });

  fire({ type: "turn-started", chatKey: "relay:a1", sessionAlias: "backend", promptRequestId: reqId });
  fire({ type: "turn-output", chatKey: "relay:a1", sessionAlias: "backend", chunk: "first" });

  // First finish
  fire({ type: "turn-finished", chatKey: "relay:a1", sessionAlias: "backend", ok: true });
  // Duplicate finish
  fire({ type: "turn-finished", chatKey: "relay:a1", sessionAlias: "backend", ok: true });

  await new Promise((r) => setTimeout(r, 10));
  expect(sent).toHaveLength(1);
  runtime.close();
});

test("state-sync restores notification provenance for matching active turn and completes with exactly 1 push", async () => {
  const { runtime, sent, cookie, fire } = await setupPushRuntime();

  let reqId: string | undefined;
  (runtime.gateway as unknown as { sendRequest: unknown }).sendRequest = async (_instanceId: string, _type: string, payload: unknown) => {
    reqId = (payload as { promptRequestId?: string }).promptRequestId;
    return { ok: true };
  };

  await runtime.app.request("/api/instances/i1/rpc", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ type: MSG.prompt, payload: { sessionAlias: "backend", text: "long running" } }),
  });

  fire({ type: "turn-started", chatKey: "relay:a1", sessionAlias: "backend", promptRequestId: reqId });
  fire({ type: "turn-output", chatKey: "relay:a1", sessionAlias: "backend", chunk: "partial" });

  const syncEvent = (payload: unknown) => runtime.gateway["deps"].onEvent!("i1", "a1", {
    protocolVersion: RELAY_PROTOCOL_VERSION, kind: "event", type: MSG.instanceStateSync, payload,
  });
  syncEvent({
    instanceId: "i1",
    turns: [
      {
        sessionAlias: "backend",
        chatKey: "relay:a1",
        startedAt: Date.now() - 5000,
        text: "partial",
        steps: [],
        reasoning: "",
        promptRequestId: reqId,
      },
    ],
    usage: [],
    commands: [],
    finishedOffline: [],
  });

  fire({ type: "turn-output", chatKey: "relay:a1", sessionAlias: "backend", chunk: " complete" });
  fire({ type: "turn-finished", chatKey: "relay:a1", sessionAlias: "backend", ok: true });

  await new Promise((r) => setTimeout(r, 10));
  expect(sent).toHaveLength(1);
  expect(JSON.parse(sent[0]!.payload)).toEqual({
    title: "MacBook · backend",
    body: "partial complete",
    instanceId: "i1",
    sessionAlias: "backend",
    url: "/",
  });
  expect(runtime.pendingWebPromptsCount?.()).toBe(0);
  runtime.close();
});

test("ambiguous transport error preserves pending grant for state-sync recovery and push", async () => {
  const { runtime, sent, cookie, fire } = await setupPushRuntime();

  let reqId: string | undefined;
  (runtime.gateway as unknown as { sendRequest: unknown }).sendRequest = async (_instanceId: string, _type: string, payload: unknown) => {
    reqId = (payload as { promptRequestId?: string }).promptRequestId;
    throw new Error("instance-reconnected");
  };

  const res = await runtime.app.request("/api/instances/i1/rpc", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ type: MSG.prompt, payload: { sessionAlias: "backend", text: "ambiguous prompt" } }),
  });
  expect(res.status).toBe(503);
  expect(reqId).toBeString();
  expect(runtime.pendingWebPromptsCount?.()).toBe(1);

  const syncEvent = (payload: unknown) => runtime.gateway["deps"].onEvent!("i1", "a1", {
    protocolVersion: RELAY_PROTOCOL_VERSION, kind: "event", type: MSG.instanceStateSync, payload,
  });
  syncEvent({
    instanceId: "i1",
    turns: [
      {
        sessionAlias: "backend",
        chatKey: "relay:a1",
        startedAt: Date.now() - 5000,
        text: "working",
        steps: [],
        reasoning: "",
        promptRequestId: reqId,
      },
    ],
    usage: [],
    commands: [],
    finishedOffline: [],
  });

  fire({ type: "turn-output", chatKey: "relay:a1", sessionAlias: "backend", chunk: " done" });
  fire({ type: "turn-finished", chatKey: "relay:a1", sessionAlias: "backend", ok: true });

  await new Promise((r) => setTimeout(r, 10));
  expect(sent).toHaveLength(1);
  expect(JSON.parse(sent[0]!.payload)).toEqual({
    title: "MacBook · backend",
    body: "working done",
    instanceId: "i1",
    sessionAlias: "backend",
    url: "/",
  });
  expect(runtime.pendingWebPromptsCount?.()).toBe(0);
  runtime.close();
});

test("active Web turn completed during connector outage sends delayed push on finishedOffline sync", async () => {
  const { runtime, sent, cookie, fire } = await setupPushRuntime();

  let reqId: string | undefined;
  (runtime.gateway as unknown as { sendRequest: unknown }).sendRequest = async (_instanceId: string, _type: string, payload: unknown) => {
    reqId = (payload as { promptRequestId?: string }).promptRequestId;
    return { ok: true };
  };

  await runtime.app.request("/api/instances/i1/rpc", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ type: MSG.prompt, payload: { sessionAlias: "backend", text: "run in outage" } }),
  });

  fire({ type: "turn-started", chatKey: "relay:a1", sessionAlias: "backend", promptRequestId: reqId });

  const syncEvent = (payload: unknown) => runtime.gateway["deps"].onEvent!("i1", "a1", {
    protocolVersion: RELAY_PROTOCOL_VERSION, kind: "event", type: MSG.instanceStateSync, payload,
  });
  syncEvent({
    instanceId: "i1",
    turns: [],
    usage: [],
    commands: [],
    finishedOffline: [
      {
        sessionAlias: "backend",
        chatKey: "relay:a1",
        startedAt: Date.now() - 5000,
        text: "outage result",
        prompt: "run in outage",
        promptRequestId: reqId,
        ok: true,
      },
    ],
  });

  await new Promise((r) => setTimeout(r, 10));
  expect(sent).toHaveLength(1);
  expect(JSON.parse(sent[0]!.payload)).toEqual({
    title: "MacBook · backend",
    body: "outage result",
    instanceId: "i1",
    sessionAlias: "backend",
    url: "/",
  });
  expect(runtime.pendingWebPromptsCount?.()).toBe(0);
  runtime.close();
});

test("session archive RPC clears pending web prompts for that session", async () => {
  const { runtime, cookie } = await setupPushRuntime();

  let reqId: string | undefined;
  (runtime.gateway as unknown as { sendRequest: unknown }).sendRequest = async (_instanceId: string, type: string, payload: unknown) => {
    if (type === MSG.prompt) {
      reqId = (payload as { promptRequestId?: string }).promptRequestId;
      return { ok: true, queued: true, queueItemId: "q1" };
    }
    return { ok: true };
  };

  const resPrompt = await runtime.app.request("/api/instances/i1/rpc", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ type: MSG.prompt, payload: { sessionAlias: "backend", text: "will be archived" } }),
  });
  expect(resPrompt.status).toBe(200);
  expect(reqId).toBeString();
  expect(runtime.pendingWebPromptsCount?.()).toBe(1);

  const resArchive = await runtime.app.request("/api/instances/i1/rpc", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ type: MSG.sessionsArchive, payload: { alias: "backend" } }),
  });
  expect(resArchive.status).toBe(200);
  expect(runtime.pendingWebPromptsCount?.()).toBe(0);
  runtime.close();
});

test("ambiguous prompt goes directly pending -> finishedOffline on reconnect (no turn-started on Hub) and triggers exactly 1 push", async () => {
  const { runtime, sent, cookie } = await setupPushRuntime();

  let reqId: string | undefined;
  (runtime.gateway as unknown as { sendRequest: unknown }).sendRequest = async (_instanceId: string, _type: string, payload: unknown) => {
    reqId = (payload as { promptRequestId?: string }).promptRequestId;
    throw new Error("instance-reconnected");
  };

  const res = await runtime.app.request("/api/instances/i1/rpc", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ type: MSG.prompt, payload: { sessionAlias: "backend", text: "ambiguous finished offline" } }),
  });
  expect(res.status).toBe(503);
  expect(reqId).toBeString();
  expect(runtime.pendingWebPromptsCount?.()).toBe(1);

  // Connector completes the turn entirely in outage and sends ONLY finishedOffline (no sync.turns)
  const syncEvent = (payload: unknown) => runtime.gateway["deps"].onEvent!("i1", "a1", {
    protocolVersion: RELAY_PROTOCOL_VERSION, kind: "event", type: MSG.instanceStateSync, payload,
  });
  syncEvent({
    instanceId: "i1",
    turns: [],
    usage: [],
    commands: [],
    finishedOffline: [
      {
        sessionAlias: "backend",
        chatKey: "relay:a1",
        startedAt: Date.now() - 5000,
        text: "direct finish in outage",
        prompt: "ambiguous finished offline",
        promptRequestId: reqId,
        ok: true,
      },
    ],
  });

  await new Promise((r) => setTimeout(r, 10));
  expect(sent).toHaveLength(1);
  expect(JSON.parse(sent[0]!.payload)).toEqual({
    title: "MacBook · backend",
    body: "direct finish in outage",
    instanceId: "i1",
    sessionAlias: "backend",
    url: "/",
  });
  expect(runtime.pendingWebPromptsCount?.()).toBe(0);
  runtime.close();
});

test("live Web turn failure-injection: first DB transaction throws -> grant stays alive -> reconnect state-sync retry triggers exactly 1 push", async () => {
  const { runtime, sent, cookie, fire } = await setupPushRuntime();

  let reqId: string | undefined;
  (runtime.gateway as unknown as { sendRequest: unknown }).sendRequest = async (_instanceId: string, _type: string, payload: unknown) => {
    reqId = (payload as { promptRequestId?: string }).promptRequestId;
    return { ok: true };
  };

  await runtime.app.request("/api/instances/i1/rpc", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ type: MSG.prompt, payload: { sessionAlias: "backend", text: "flaky db prompt" } }),
  });

  fire({ type: "turn-started", chatKey: "relay:a1", sessionAlias: "backend", promptRequestId: reqId });
  fire({ type: "turn-output", chatKey: "relay:a1", sessionAlias: "backend", chunk: "flaky done" });

  // Mock db.transaction to fail once
  const origTransaction = runtime.db.transaction.bind(runtime.db);
  let failOnce = true;
  runtime.db.transaction = (fn: () => void) => {
    if (failOnce) {
      failOnce = false;
      throw new Error("simulated disk error");
    }
    return origTransaction(fn);
  };
  // First finish fails transaction, logs persist_failed, and forces disconnect (swallowed at onEvent boundary)
  fire({ type: "turn-finished", chatKey: "relay:a1", sessionAlias: "backend", ok: true, recoveryId: "rec-1" });
  expect(sent).toHaveLength(0);
  // Grant must STILL be present in memory for the retry
  expect(runtime.pendingWebPromptsCount?.()).toBe(1);
  // Connector reconnects and re-sends via finishedOffline
  const syncEvent = (payload: unknown) => runtime.gateway["deps"].onEvent!("i1", "a1", {
    protocolVersion: RELAY_PROTOCOL_VERSION, kind: "event", type: MSG.instanceStateSync, payload,
  });
  syncEvent({
    instanceId: "i1",
    turns: [],
    usage: [],
    commands: [],
    finishedOffline: [
      {
        sessionAlias: "backend",
        chatKey: "relay:a1",
        startedAt: Date.now() - 5000,
        text: "flaky done",
        prompt: "flaky db prompt",
        promptRequestId: reqId,
        recoveryId: "rec-1",
        ok: true,
      },
    ],
  });

  await new Promise((r) => setTimeout(r, 10));
  expect(sent).toHaveLength(1);
  expect(JSON.parse(sent[0]!.payload)).toEqual({
    title: "MacBook · backend",
    body: "flaky done",
    instanceId: "i1",
    sessionAlias: "backend",
    url: "/",
  });
  expect(runtime.pendingWebPromptsCount?.()).toBe(0);
  runtime.close();
});

test("capacity pressure evicts oldest pending grant while protecting active grants", async () => {
  const { runtime, sent, cookie, fire } = await setupPushRuntime();

  let activeReqId: string | undefined;
  (runtime.gateway as unknown as { sendRequest: unknown }).sendRequest = async (_instanceId: string, _type: string, payload: unknown) => {
    activeReqId = (payload as { promptRequestId?: string }).promptRequestId;
    return { ok: true };
  };

  // Submit active prompt and start it
  await runtime.app.request("/api/instances/i1/rpc", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ type: MSG.prompt, payload: { sessionAlias: "backend", text: "active prompt" } }),
  });
  fire({ type: "turn-started", chatKey: "relay:a1", sessionAlias: "backend", promptRequestId: activeReqId });
  fire({ type: "turn-output", chatKey: "relay:a1", sessionAlias: "backend", chunk: "running" });

  // Flood with 5000 queued/pending prompts to trigger capacity eviction (limit 4096)
  (runtime.gateway as unknown as { sendRequest: unknown }).sendRequest = async (_instanceId: string, _type: string, _payload: unknown) => {
    return { ok: true, queued: true, queueItemId: "q-flood" };
  };
  for (let i = 0; i < 4100; i++) {
    await runtime.app.request("/api/instances/i1/rpc", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ type: MSG.prompt, payload: { sessionAlias: `s-${i}`, text: `flood-${i}` } }),
    });
  }

  // Capacity capped at 4096, and active grant was NOT evicted
  expect(runtime.pendingWebPromptsCount?.()).toBe(4096);

  // Active turn finishes and sends push successfully
  fire({ type: "turn-finished", chatKey: "relay:a1", sessionAlias: "backend", ok: true });

  await new Promise((r) => setTimeout(r, 10));
  expect(sent).toHaveLength(1);
  expect(JSON.parse(sent[0]!.payload)).toEqual({
    title: "MacBook · backend",
    body: "running",
    instanceId: "i1",
    sessionAlias: "backend",
    url: "/",
  });
  runtime.close();
});

test("finishedOffline persistence failure-injection: first persist throws -> grant stays alive -> re-sent finishedOffline succeeds and pushes exactly once", async () => {
  const { runtime, sent, cookie } = await setupPushRuntime();

  let reqId: string | undefined;
  (runtime.gateway as unknown as { sendRequest: unknown }).sendRequest = async (_instanceId: string, _type: string, payload: unknown) => {
    reqId = (payload as { promptRequestId?: string }).promptRequestId;
    return { ok: true };
  };

  await runtime.app.request("/api/instances/i1/rpc", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ type: MSG.prompt, payload: { sessionAlias: "backend", text: "flaky offline prompt" } }),
  });

  expect(reqId).toBeString();
  expect(runtime.pendingWebPromptsCount?.()).toBe(1);

  // Mock db.transaction to fail once on first state-sync
  const origTransaction = runtime.db.transaction.bind(runtime.db);
  let failOnce = true;
  runtime.db.transaction = (fn: () => void) => {
    if (failOnce) {
      failOnce = false;
      throw new Error("simulated sync disk error");
    }
    return origTransaction(fn);
  };

  const syncEvent = (payload: unknown) => runtime.gateway["deps"].onEvent!("i1", "a1", {
    protocolVersion: RELAY_PROTOCOL_VERSION, kind: "event", type: MSG.instanceStateSync, payload,
  });

  // First sync throws, logs persist_failed, and forces disconnect
  syncEvent({
    instanceId: "i1",
    turns: [],
    usage: [],
    commands: [],
    finishedOffline: [
      {
        sessionAlias: "backend",
        chatKey: "relay:a1",
        startedAt: Date.now() - 5000,
        text: "flaky offline done",
        prompt: "flaky offline prompt",
        promptRequestId: reqId,
        recoveryId: "rec-offline-1",
        ok: true,
      },
    ],
  });

  expect(sent).toHaveLength(0);
  // Grant must still be present for the retry
  expect(runtime.pendingWebPromptsCount?.()).toBe(1);

  // Second sync succeeds
  syncEvent({
    instanceId: "i1",
    turns: [],
    usage: [],
    commands: [],
    finishedOffline: [
      {
        sessionAlias: "backend",
        chatKey: "relay:a1",
        startedAt: Date.now() - 5000,
        text: "flaky offline done",
        prompt: "flaky offline prompt",
        promptRequestId: reqId,
        recoveryId: "rec-offline-1",
        ok: true,
      },
    ],
  });

  await new Promise((r) => setTimeout(r, 10));
  expect(sent).toHaveLength(1);
  expect(JSON.parse(sent[0]!.payload)).toEqual({
    title: "MacBook · backend",
    body: "flaky offline done",
    instanceId: "i1",
    sessionAlias: "backend",
    url: "/",
  });
  expect(runtime.pendingWebPromptsCount?.()).toBe(0);
  runtime.close();
});

test("finishedOffline with matching promptRequestId but wrong session does not push and does not delete grant", async () => {
  const { runtime, sent, cookie } = await setupPushRuntime();

  let reqId: string | undefined;
  (runtime.gateway as unknown as { sendRequest: unknown }).sendRequest = async (_instanceId: string, _type: string, payload: unknown) => {
    reqId = (payload as { promptRequestId?: string }).promptRequestId;
    return { ok: true };
  };

  await runtime.app.request("/api/instances/i1/rpc", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ type: MSG.prompt, payload: { sessionAlias: "backend", text: "task on backend" } }),
  });

  expect(reqId).toBeString();
  expect(runtime.pendingWebPromptsCount?.()).toBe(1);

  const syncEvent = (payload: unknown) => runtime.gateway["deps"].onEvent!("i1", "a1", {
    protocolVersion: RELAY_PROTOCOL_VERSION, kind: "event", type: MSG.instanceStateSync, payload,
  });
  syncEvent({
    instanceId: "i1",
    turns: [],
    usage: [],
    commands: [],
    finishedOffline: [
      {
        sessionAlias: "other-session",
        chatKey: "relay:a1",
        startedAt: Date.now() - 5000,
        text: "done on other",
        prompt: "task on backend",
        promptRequestId: reqId,
        ok: true,
      },
    ],
  });

  await new Promise((r) => setTimeout(r, 10));
  expect(sent).toHaveLength(0);
  expect(runtime.pendingWebPromptsCount?.()).toBe(1);
  runtime.close();
});

test("capacity saturation with only active grants rejects new registration without evicting active grants", async () => {
  const { runtime, sent, cookie, fire } = await setupPushRuntime();

  const activeIds: string[] = [];
  for (let i = 0; i < 4096; i++) {
    const alias = `active-session-${i}`;
    let registeredId: string | undefined;
    (runtime.gateway as unknown as { sendRequest: unknown }).sendRequest = async (_instanceId: string, _type: string, payload: unknown) => {
      registeredId = (payload as { promptRequestId?: string }).promptRequestId;
      return { ok: true };
    };
    await runtime.app.request("/api/instances/i1/rpc", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ type: MSG.prompt, payload: { sessionAlias: alias, text: `task-${i}` } }),
    });
    fire({ type: "turn-started", chatKey: "relay:a1", sessionAlias: alias, promptRequestId: registeredId });
    activeIds.push(registeredId!);
  }

  expect(runtime.pendingWebPromptsCount?.()).toBe(4096);

  let overflowId: string | undefined;
  (runtime.gateway as unknown as { sendRequest: unknown }).sendRequest = async (_instanceId: string, _type: string, payload: unknown) => {
    overflowId = (payload as { promptRequestId?: string }).promptRequestId;
    return { ok: true };
  };
  await runtime.app.request("/api/instances/i1/rpc", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ type: MSG.prompt, payload: { sessionAlias: "overflow-session", text: "overflow" } }),
  });

  expect(runtime.pendingWebPromptsCount?.()).toBe(4096);

  fire({ type: "turn-finished", chatKey: "relay:a1", sessionAlias: "active-session-0", ok: true, text: "done 0" });
  await new Promise((r) => setTimeout(r, 10));
  expect(sent).toHaveLength(1);
  expect(JSON.parse(sent[0]!.payload).title).toBe("MacBook · active-session-0");
  runtime.close();
});
test("active grant is NOT pruned by 24h pending TTL while pending grants expire", async () => {
  let currentTime = Date.now();
  const { runtime, sent, cookie, fire } = await setupPushRuntime({
    now: () => new Date(currentTime),
  });
  let pendingId: string | undefined;
  (runtime.gateway as unknown as { sendRequest: unknown }).sendRequest = async (_instanceId: string, _type: string, payload: unknown) => {
    pendingId = (payload as { promptRequestId?: string }).promptRequestId;
    return { ok: true, queued: true, queueItemId: "q-stale" };
  };
  await runtime.app.request("/api/instances/i1/rpc", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ type: MSG.prompt, payload: { sessionAlias: "pending-session", text: "abandoned" } }),
  });
  expect(runtime.pendingWebPromptsCount?.()).toBe(1);

  // 2. Submit active prompt and start it
  let activeId: string | undefined;
  (runtime.gateway as unknown as { sendRequest: unknown }).sendRequest = async (_instanceId: string, _type: string, payload: unknown) => {
    activeId = (payload as { promptRequestId?: string }).promptRequestId;
    return { ok: true };
  };
  await runtime.app.request("/api/instances/i1/rpc", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ type: MSG.prompt, payload: { sessionAlias: "backend", text: "multi-day task" } }),
  });
  fire({ type: "turn-started", chatKey: "relay:a1", sessionAlias: "backend", promptRequestId: activeId });
  expect(runtime.pendingWebPromptsCount?.()).toBe(2);

  // 3. Advance clock by 48 hours (well past 24h TTL)
  currentTime += 48 * 60 * 60_000;

  // 4. Register another prompt at current time to trigger prunePendingWebPrompts()
  await runtime.app.request("/api/instances/i1/rpc", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ type: MSG.prompt, payload: { sessionAlias: "new-session", text: "trigger prune" } }),
  });

  // The expired pending grant was pruned, but the 48h-old active grant was preserved!
  // Count: 2 (active grant + new trigger grant)
  expect(runtime.pendingWebPromptsCount?.()).toBe(2);

  // 5. Active turn finishes and successfully pushes
  fire({ type: "turn-finished", chatKey: "relay:a1", sessionAlias: "backend", ok: true, text: "finally done" });
  await new Promise((r) => setTimeout(r, 10));
  expect(sent).toHaveLength(1);
  expect(JSON.parse(sent[0]!.payload)).toEqual({
    title: "MacBook · backend",
    body: "finally done",
    instanceId: "i1",
    sessionAlias: "backend",
    url: "/",
  });
});
