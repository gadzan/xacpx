import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocketServer } from "ws";

import { MSG } from "../../../../packages/relay-protocol/src/index";
import { createRelayRuntime } from "../../../../packages/relay/src/server";
import { CredentialStore } from "../../../../packages/channel-relay/src/credential-store";
import { createControlBridge, subscribeControlEvents } from "../../../../packages/channel-relay/src/control-bridge";
import { RelayClient } from "../../../../packages/channel-relay/src/relay-client";

test("pair -> credential persisted -> rpc via http proxy -> event ingestion", async () => {
  const runtime = await createRelayRuntime(":memory:");
  const wss = new WebSocketServer({ port: 0 });
  await new Promise<void>((resolve) => wss.on("listening", () => resolve()));
  wss.on("connection", (socket) => runtime.gateway.handleConnection(socket));
  const wsUrl = `ws://127.0.0.1:${(wss.address() as { port: number }).port}`;

  // admin + login cookie + pairing token (over the real HTTP app)
  const adminAccount = runtime.accounts.createAccount("admin");
  const { token: loginToken } = runtime.accounts.createLoginToken(adminAccount.id);
  const loginRes = await runtime.app.request("/api/login", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: loginToken }),
  });
  const cookie = loginRes.headers.get("set-cookie")?.split(";")[0] ?? "";
  const tokenRes = await runtime.app.request("/api/instances/pairing-token", {
    method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ name: "it-pc" }),
  });
  const { token } = (await tokenRes.json()) as { token: string };

  // fake ControlService driven by the real bridge
  const listeners: Array<(event: unknown) => void> = [];
  const fakeControl = {
    listSessions: () => [{ alias: "backend", agent: "claude", workspace: "/ws", transportSession: "t", running: false }],
    events: { subscribe: (listener: (event: unknown) => void) => { listeners.push(listener); return () => {}; } },
  };

  // real connector pieces
  const credentialPath = join(mkdtempSync(join(tmpdir(), "relay-it-")), "credential.json");
  const credentialStore = new CredentialStore(credentialPath);
  const controller = new AbortController();
  const ready = new Promise<void>((resolve) => {
    const client = new RelayClient({
      url: wsUrl, credentialStore, pairingToken: token, coreVersion: "0.11.0",
      onRequest: createControlBridge(fakeControl as never),
      onReady: resolve, reconnectDelaysMs: [0],
    });
    subscribeControlEvents(fakeControl as never, (type, payload) => client.sendEvent(type, payload));
    client.start(controller.signal);
  });
  await ready;

  // pairing persisted a credential
  expect(credentialStore.load()?.instanceId).toBeTruthy();

  // instance listed online; rpc proxies through to the bridge
  const listRes = await runtime.app.request("/api/instances", { headers: { cookie } });
  const { instances } = (await listRes.json()) as { instances: Array<{ id: string; online: boolean; name: string }> };
  expect(instances[0]?.online).toBe(true);
  expect(instances[0]?.name).toBe("it-pc");

  const rpcRes = await runtime.app.request(`/api/instances/${instances[0]!.id}/rpc`, {
    method: "POST", headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ type: MSG.sessionsList, payload: {} }),
  });
  expect(rpcRes.status).toBe(200);
  expect(await rpcRes.json()).toEqual({
    result: { sessions: [{ alias: "backend", agent: "claude", workspace: "/ws", transportSession: "t", running: false }] },
  });

  // capture last_seen before firing a control event
  const beforeRes = (await (await runtime.app.request("/api/instances", { headers: { cookie } })).json()) as {
    instances: Array<{ lastSeenAt: string | null }>;
  };
  const beforeSeen = beforeRes.instances[0]?.lastSeenAt;
  expect(beforeSeen).toBeTruthy(); // set by the pairing handshake

  // a control event forwarded up must refresh last_seen to a strictly later time
  listeners.forEach((listener) => listener({ type: "sessions-changed" }));
  await new Promise((resolve) => setTimeout(resolve, 100));
  const after = (await (await runtime.app.request("/api/instances", { headers: { cookie } })).json()) as {
    instances: Array<{ lastSeenAt: string | null }>;
  };
  const afterSeen = after.instances[0]?.lastSeenAt;
  expect(afterSeen).toBeTruthy();
  expect(new Date(afterSeen!).getTime()).toBeGreaterThan(new Date(beforeSeen!).getTime());

  controller.abort();
  wss.close();
  runtime.close();
});

test("agent-message control event is persisted into SQLite messages store", async () => {
  const runtime = await createRelayRuntime(":memory:");
  const wss = new WebSocketServer({ port: 0 });
  await new Promise<void>((resolve) => wss.on("listening", () => resolve()));
  wss.on("connection", (socket) => runtime.gateway.handleConnection(socket));
  const wsUrl = `ws://127.0.0.1:${(wss.address() as { port: number }).port}`;

  const adminAccount = runtime.accounts.createAccount("admin2");
  const { token: loginToken } = runtime.accounts.createLoginToken(adminAccount.id);
  const loginRes = await runtime.app.request("/api/login", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: loginToken }),
  });
  const cookie = loginRes.headers.get("set-cookie")?.split(";")[0] ?? "";
  const tokenRes = await runtime.app.request("/api/instances/pairing-token", {
    method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ name: "agent-pc" }),
  });
  const { token } = (await tokenRes.json()) as { token: string };

  const listeners: Array<(event: unknown) => void> = [];
  const fakeControl = {
    listSessions: () => [{ alias: "workerA", agent: "codex", workspace: "/ws", transportSession: "t", running: false }],
    events: { subscribe: (listener: (event: unknown) => void) => { listeners.push(listener); return () => {}; } },
  };

  const credentialPath = join(mkdtempSync(join(tmpdir(), "relay-agent-msg-")), "credential.json");
  const credentialStore = new CredentialStore(credentialPath);
  const controller = new AbortController();
  await new Promise<void>((resolve) => {
    const client = new RelayClient({
      url: wsUrl, credentialStore, pairingToken: token, coreVersion: "0.11.0",
      onRequest: createControlBridge(fakeControl as never),
      onReady: resolve, reconnectDelaysMs: [0],
    });
    subscribeControlEvents(fakeControl as never, (type, payload) => client.sendEvent(type, payload));
    client.start(controller.signal);
  });

  const cred = credentialStore.load();
  expect(cred?.instanceId).toBeTruthy();
  const instanceId = cred!.instanceId;

  const peerMessage = {
    kind: "agent_message" as const,
    direction: "sent" as const,
    messageId: "msg_collab_1",
    conversationId: "conv_1",
    peer: {
      handle: "agent:node_2:endpoint_b",
      displayName: "Frontend",
      agent: "claude",
      workspace: "web",
    },
    content: "Please update the user schema.",
    createdAt: 1771234567890,
    status: "sent" as const,
  };

  listeners.forEach((l) => l({
    type: "agent-message",
    sessionAlias: "workerA",
    message: peerMessage,
  }));

  await new Promise((r) => setTimeout(r, 100));

  const stored = runtime.messages.listBySession(adminAccount.id, instanceId, "workerA").messages;
  expect(stored.length).toBe(1);
  expect(stored[0]?.direction).toBe("out");
  expect(stored[0]?.text).toBe("Please update the user schema.");
  expect(stored[0]?.structured?.agentMessage).toEqual(peerMessage);

  controller.abort();
  wss.close();
  runtime.close();
});
