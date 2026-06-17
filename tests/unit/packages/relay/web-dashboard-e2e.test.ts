import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";

import { decodeEnvelope, parseWebServerEvent } from "../../../../packages/relay-protocol/src/index";
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

  // instance emits a streamed turn (turn-started opens the accumulator)
  listeners.forEach((l) => l({ type: "turn-started", chatKey: "relay:x", sessionAlias: "backend" }));
  listeners.forEach((l) => l({ type: "turn-output", chatKey: "relay:x", sessionAlias: "backend", chunk: "done" }));
  listeners.forEach((l) => l({ type: "turn-finished", chatKey: "relay:x", sessionAlias: "backend", ok: true }));
  await new Promise((r) => setTimeout(r, 200));

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
