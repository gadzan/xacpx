import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";

import { decodeEnvelope, encodeEnvelope, parseWebServerEvent, webClientEnvelope } from "../../../../packages/relay-protocol/src/index";
import { startRelayServer } from "../../../../packages/relay/src/server";
import { CredentialStore } from "../../../../packages/channel-relay/src/credential-store";
import { createControlBridge, subscribeControlEvents } from "../../../../packages/channel-relay/src/control-bridge";
import { RelayClient } from "../../../../packages/channel-relay/src/relay-client";

test("instance event flows to web client and is cached as history", async () => {
  const relay = await startRelayServer({ dbPath: ":memory:", httpPort: 0, wsPort: 0, host: "127.0.0.1" });
  const base = `http://127.0.0.1:${relay.httpPort}`;

  const adminAccount = relay.runtime.accounts.createAccount("admin");
  const { token: loginToken } = relay.runtime.accounts.createLoginToken(adminAccount.id);
  const login = await fetch(`${base}/api/login`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: loginToken }),
  });
  const cookie = login.headers.get("set-cookie")?.split(";")[0] ?? "";
  const tokenRes = await fetch(`${base}/api/instances/pairing-token`, {
    method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ name: "pc" }),
  });
  const { token } = (await tokenRes.json()) as { token: string };

  const listeners: Array<(event: unknown) => void> = [];
  const fakeControl = {
    listSessions: () => [],
    events: { subscribe: (l: (event: unknown) => void) => { listeners.push(l); return () => {}; } },
  };

  const credentialPath = join(mkdtempSync(join(tmpdir(), "relay-e2e-")), "credential.json");
  const controller = new AbortController();
  await new Promise<void>((resolve) => {
    const client = new RelayClient({
      url: `ws://127.0.0.1:${relay.wsPort}`, credentialStore: new CredentialStore(credentialPath),
      pairingToken: token, coreVersion: "0.11.0",
      onRequest: createControlBridge(fakeControl as never), onReady: resolve, reconnectDelaysMs: [0],
    });
    subscribeControlEvents(fakeControl as never, (type, payload) => client.sendEvent(type, payload));
    client.start(controller.signal);
  });

  // web client connects and collects events
  const ws = new WebSocket(`ws://127.0.0.1:${relay.httpPort}/ws`, { headers: { cookie } });
  const events: string[] = [];
  ws.on("message", (d) => events.push(String(d)));
  await new Promise<void>((resolve) => ws.on("open", () => resolve()));

  // resolve the instance id up front (needed for the active-turns assertions below)
  const listRes0 = await fetch(`${base}/api/instances`, { headers: { cookie } });
  const { instances: insts0 } = (await listRes0.json()) as { instances: Array<{ id: string }> };
  const instId0 = insts0[0]!.id;

  // instance emits a streamed turn (turn-started opens the accumulator)
  listeners.forEach((l) => l({ type: "turn-started", chatKey: "relay:x", sessionAlias: "backend" }));
  listeners.forEach((l) => l({ type: "turn-output", chatKey: "relay:x", sessionAlias: "backend", chunk: "done" }));
  // Context-usage meter: retained per session (replace-latest), must survive turn-finished.
  listeners.forEach((l) => l({ type: "turn-usage", chatKey: "relay:x", sessionAlias: "backend", used: 1200, size: 8000 }));
  // Agent-advertised slash commands: also retained per session (replace-latest), so the
  // composer's "/" hints survive a refresh (agents typically advertise once at start).
  listeners.forEach((l) => l({ type: "agent-commands", chatKey: "relay:x", sessionAlias: "backend", commands: [{ name: "compact", description: "Compact" }] }));
  await new Promise((r) => setTimeout(r, 50));

  // Mid-turn (before turn-finished): the in-flight snapshot is exposed so a refreshed
  // web client can rebuild the live view instead of losing the running task.
  const activeRes = await fetch(`${base}/api/active-turns`, { headers: { cookie } });
  const { turns, usage, commands } = (await activeRes.json()) as {
    turns: Array<{ instanceId: string; sessionAlias: string; status: string; parts: Array<{ type: string; text?: string }> }>;
    usage: Array<{ instanceId: string; sessionAlias: string; used: number; size: number }>;
    commands: Array<{ instanceId: string; sessionAlias: string; commands: Array<{ name: string; description?: string }> }>;
  };
  expect(turns).toHaveLength(1);
  expect(turns[0]!.sessionAlias).toBe("backend");
  expect(turns[0]!.instanceId).toBe(instId0);
  expect(turns[0]!.status).toBe("streaming");
  expect(turns[0]!.parts).toEqual([{ type: "text", text: "done" }]);
  // The usage meter is exposed in the same snapshot so a refresh restores the bar.
  expect(usage).toEqual([{ instanceId: instId0, sessionAlias: "backend", used: 1200, size: 8000 }]);
  // The advertised command list rides along too so a refresh restores the "/" hints.
  expect(commands).toEqual([{ instanceId: instId0, sessionAlias: "backend", commands: [{ name: "compact", description: "Compact" }] }]);

  // Subscription acknowledgement is an authoritative snapshot on the SAME socket.
  // Later streamed deltas are therefore ordered after it, unlike the HTTP snapshot.
  ws.send(encodeEnvelope(webClientEnvelope({ kind: "subscribe", instanceIds: [instId0] })));
  await new Promise((r) => setTimeout(r, 50));
  const stateSnapshot = events
    .map((raw) => { const d = decodeEnvelope(raw); return d.ok ? parseWebServerEvent(d.envelope) : null; })
    .find((event) => event?.kind === "state-snapshot");
  expect(stateSnapshot).toMatchObject({
    kind: "state-snapshot",
    instanceId: instId0,
    turns: [{ sessionAlias: "backend", status: "streaming", parts: [{ type: "text", text: "done" }] }],
  });

  listeners.forEach((l) => l({ type: "turn-finished", chatKey: "relay:x", sessionAlias: "backend", ok: true }));
  await new Promise((r) => setTimeout(r, 200));

  const orderedWebEvents = events
    .map((raw) => { const d = decodeEnvelope(raw); return d.ok ? parseWebServerEvent(d.envelope) : null; })
    .filter((event) => event !== null);
  const snapshotIndex = orderedWebEvents.findIndex((event) => event.kind === "state-snapshot");
  const finishIndex = orderedWebEvents.findIndex((event) => event.kind === "control-event" && event.event.type === "turn-finished");
  expect(snapshotIndex).toBeGreaterThanOrEqual(0);
  expect(finishIndex).toBeGreaterThan(snapshotIndex);

  // After the turn settles, the turn snapshot is empty (flushed to history) — but the
  // usage meter is session-scoped and PERSISTS, so the context bar survives a refresh.
  const activeAfter = await fetch(`${base}/api/active-turns`, { headers: { cookie } });
  const afterJson = (await activeAfter.json()) as { turns: unknown[]; usage: Array<{ sessionAlias: string; used: number }>; commands: Array<{ sessionAlias: string; commands: Array<{ name: string }> }> };
  expect(afterJson.turns).toHaveLength(0);
  expect(afterJson.usage).toEqual([{ instanceId: instId0, sessionAlias: "backend", used: 1200, size: 8000 }]);
  // Like the usage meter, the advertised command list is session-scoped and PERSISTS.
  expect(afterJson.commands).toEqual([{ instanceId: instId0, sessionAlias: "backend", commands: [{ name: "compact", description: "Compact" }] }]);

  const kinds = events
    .map((raw) => { const d = decodeEnvelope(raw); return d.ok ? parseWebServerEvent(d.envelope) : null; })
    .filter(Boolean)
    .map((e) => e!.kind);
  expect(kinds).toContain("control-event");

  // instance id via the HTTP API (camelCase id), then history shows the cached turn output
  const listRes = await fetch(`${base}/api/instances`, { headers: { cookie } });
  const { instances } = (await listRes.json()) as { instances: Array<{ id: string }> };
  const instanceId = instances[0]!.id;
  const histRes = await fetch(`${base}/api/instances/${instanceId}/sessions/backend/messages`, { headers: { cookie } });
  const { messages } = (await histRes.json()) as { messages: Array<{ direction: string; text: string }> };
  expect(messages.map((m) => [m.direction, m.text])).toEqual([["out", "done"]]);

  ws.close();
  controller.abort();
  await relay.close();
});

test("merged mode (no wsPort): a connector pairs over the HTTP port root and registers", async () => {
  // Omitting wsPort merges the instance gateway onto the HTTP port.
  const relay = await startRelayServer({ dbPath: ":memory:", httpPort: 0, host: "127.0.0.1" });
  expect(relay.wsPort).toBeNull();
  const base = `http://127.0.0.1:${relay.httpPort}`;

  const account = relay.runtime.accounts.createAccount("admin");
  const { token: loginToken } = relay.runtime.accounts.createLoginToken(account.id);
  const login = await fetch(`${base}/api/login`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: loginToken }),
  });
  const cookie = login.headers.get("set-cookie")?.split(";")[0] ?? "";
  const tokenRes = await fetch(`${base}/api/instances/pairing-token`, {
    method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ name: "pc" }),
  });
  const { token } = (await tokenRes.json()) as { token: string };

  const fakeControl = { listSessions: () => [], events: { subscribe: () => () => {} } };
  const credentialPath = join(mkdtempSync(join(tmpdir(), "relay-merged-")), "credential.json");
  const controller = new AbortController();
  // Connector dials the HTTP port at the root path — exactly what the bare-host shorthand resolves to.
  await new Promise<void>((resolve) => {
    const client = new RelayClient({
      url: `ws://127.0.0.1:${relay.httpPort}`, credentialStore: new CredentialStore(credentialPath),
      pairingToken: token, coreVersion: "0.11.0",
      onRequest: createControlBridge(fakeControl as never), onReady: resolve, reconnectDelaysMs: [0],
    });
    client.start(controller.signal);
  });

  const listRes = await fetch(`${base}/api/instances`, { headers: { cookie } });
  const { instances } = (await listRes.json()) as { instances: Array<{ name: string; online: boolean }> };
  expect(instances).toHaveLength(1);
  expect(instances[0]!.name).toBe("pc");
  expect(instances[0]!.online).toBe(true);

  controller.abort();
  await relay.close();
});
