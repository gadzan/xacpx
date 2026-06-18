// tests/unit/packages/relay/web-ws-integration.test.ts
import { expect, test } from "bun:test";
import { WebSocket } from "ws";
import { decodeEnvelope, parseWebServerEvent } from "../../../../packages/relay-protocol/src/index";
import { startRelayServer } from "../../../../packages/relay/src/server";

test("authenticated /ws receives account-scoped fan-out; unauthenticated is rejected", async () => {
  const relay = await startRelayServer({ dbPath: ":memory:", httpPort: 0, wsPort: 0, host: "127.0.0.1" });
  const base = `http://127.0.0.1:${relay.httpPort}`;

  const adminAccount = relay.runtime.accounts.createAccount("admin");
  const { token: loginToken } = relay.runtime.accounts.createLoginToken(adminAccount.id);
  const login = await fetch(`${base}/api/login`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: loginToken }),
  });
  const cookie = login.headers.get("set-cookie")?.split(";")[0] ?? "";
  const accountId = relay.runtime.accounts.findByUsername("admin")!.id;

  // unauthenticated upgrade is refused
  const refused = new WebSocket(`ws://127.0.0.1:${relay.httpPort}/ws`);
  await new Promise<void>((resolve) => { refused.on("error", () => resolve()); refused.on("open", () => { refused.close(); resolve(); }); });
  expect(refused.readyState).not.toBe(WebSocket.OPEN);

  // authenticated upgrade with the session cookie
  const ws = new WebSocket(`ws://127.0.0.1:${relay.httpPort}/ws`, { headers: { cookie } });
  const message = new Promise<string>((resolve) => ws.on("message", (d) => resolve(String(d))));
  await new Promise<void>((resolve) => ws.on("open", () => resolve()));

  relay.runtime.webGateway.broadcast(accountId, { kind: "instance-status", instanceId: "i1", online: true });
  const decoded = decodeEnvelope(await message);
  expect(decoded.ok && parseWebServerEvent(decoded.envelope)).toEqual({ kind: "instance-status", instanceId: "i1", online: true });

  // a valid cookie on a non-/ws path must still be refused (no over-match)
  const bogus = new WebSocket(`ws://127.0.0.1:${relay.httpPort}/wsfoo`, { headers: { cookie } });
  let bogusOpened = false;
  await new Promise<void>((resolve) => { bogus.on("error", () => resolve()); bogus.on("open", () => { bogusOpened = true; bogus.close(); resolve(); }); });
  expect(bogusOpened).toBe(false);

  ws.close();
  await relay.close();
});
