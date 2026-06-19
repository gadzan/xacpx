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

  // Dedicated mode (wsPort given): the merged gateway routes must NOT leak onto the
  // HTTP port — the gateway lives on its own port, so `/` and `/gateway` are refused here.
  for (const p of ["/", "/gateway"]) {
    const gw = new WebSocket(`ws://127.0.0.1:${relay.httpPort}${p}`);
    let opened = false;
    await new Promise<void>((resolve) => { gw.on("error", () => resolve()); gw.on("open", () => { opened = true; gw.close(); resolve(); }); });
    expect(opened).toBe(false);
  }

  ws.close();
  await relay.close();
});

test("merged mode (no wsPort): HTTP port routes gateway upgrades at / and /gateway, rejects unknown paths", async () => {
  const relay = await startRelayServer({ dbPath: ":memory:", httpPort: 0, host: "127.0.0.1" });
  expect(relay.wsPort).toBeNull();

  // The gateway accepts the upgrade then waits in-band for the register envelope,
  // so a bare socket that routes to it OPENs; a destroyed (unrouted) path errors.
  async function opens(path: string): Promise<boolean> {
    const sock = new WebSocket(`ws://127.0.0.1:${relay.httpPort}${path}`);
    return await new Promise<boolean>((resolve) => {
      sock.on("error", () => resolve(false));
      sock.on("open", () => { sock.close(); resolve(true); });
    });
  }

  expect(await opens("/")).toBe(true);          // bare-host shorthand lands here
  expect(await opens("/gateway")).toBe(true);   // explicit gateway path
  expect(await opens("/gateway/")).toBe(true);  // trailing slash tolerated
  expect(await opens("/wsfoo")).toBe(false);    // unknown path destroyed
  expect(await opens("/ws")).toBe(false);       // dashboard path needs a cookie

  await relay.close();
});
