import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MSG } from "../../../../packages/relay-protocol/src/index";
import { createSqlDriver, initSchema } from "../../../../packages/relay/src/db";
import { AccountStore } from "../../../../packages/relay/src/stores/accounts";
import { InstanceStore } from "../../../../packages/relay/src/stores/instances";
import { MessageStore } from "../../../../packages/relay/src/stores/messages";
import { createApp, GLOBAL_MAX_FAILURES, LOGIN_MAX_FAILURES } from "../../../../packages/relay/src/http/app";
import { createRelayRuntime } from "../../../../packages/relay/src/server";

async function makeApp(opts: { trustProxy?: boolean; now?: () => Date } = {}) {
  const db = await createSqlDriver(":memory:");
  initSchema(db);
  const accounts = new AccountStore(db);
  const instances = new InstanceStore(db);
  const admin = accounts.createAccount("admin");
  const { token: loginToken } = accounts.createLoginToken(admin.id, "test");
  const rpcCalls: Array<{ instanceId: string; type: string; payload: unknown }> = [];
  const gateway = {
    isOnline: (id: string) => id !== "offline-id",
    sendRequest: async (instanceId: string, type: string, payload: unknown) => {
      rpcCalls.push({ instanceId, type, payload });
      return { sessions: [] };
    },
  };
  const messages = new MessageStore(db);
  const app = createApp({
    accounts, instances, gateway, messages,
    trustProxy: opts.trustProxy,
    now: opts.now,
  });

  /** Login with a login token; returns response + extracted session cookie value. */
  const login = async (token: string, xff?: string) => {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (xff) headers["x-forwarded-for"] = xff;
    const res = await app.request("/api/login", {
      method: "POST",
      headers,
      body: JSON.stringify({ token }),
    });
    return { res, cookie: res.headers.get("set-cookie")?.split(";")[0] ?? "" };
  };

  return { app, accounts, instances, admin, loginToken, gateway, rpcCalls, messages, login };
}

test("login with valid token → 200, sets HttpOnly cookie; authed request succeeds; unauthenticated → 401", async () => {
  const { app, loginToken, login } = await makeApp();
  const { res, cookie } = await login(loginToken);
  expect(res.status).toBe(200);
  const body = await res.json() as { username: string };
  expect(body.username).toBe("admin");
  expect(res.headers.get("set-cookie")).toContain("HttpOnly");

  // Subsequent authed request works
  const me = await app.request("/api/me", { headers: { cookie } });
  expect(me.status).toBe(200);
  expect(((await me.json()) as { username: string }).username).toBe("admin");

  // Without cookie → 401
  expect((await app.request("/api/me")).status).toBe(401);
});

test("login with bad token → 401 {error:invalid-token}", async () => {
  const { login } = await makeApp();
  const { res } = await login("bad-token-value");
  expect(res.status).toBe(401);
  expect(((await res.json()) as { error: string }).error).toBe("invalid-token");
});

test("POST /api/register → 404 (route removed)", async () => {
  const { app } = await makeApp();
  const res = await app.request("/api/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "x", password: "y" }),
  });
  expect(res.status).toBe(404);
});

test("POST /api/invites → 404 (route removed)", async () => {
  const { app, loginToken, login } = await makeApp();
  const { cookie } = await login(loginToken);
  const res = await app.request("/api/invites", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
  });
  expect(res.status).toBe(404);
});

test("GET /api/me returns {username} with NO role key", async () => {
  const { app, loginToken, login } = await makeApp();
  const { cookie } = await login(loginToken);
  const res = await app.request("/api/me", { headers: { cookie } });
  expect(res.status).toBe(200);
  const body = await res.json() as Record<string, unknown>;
  expect(body.username).toBe("admin");
  expect("role" in body).toBe(false);
});

test("per-IP rate limit: N failed logins from the same resolved IP → 429", async () => {
  // In the Hono test harness there is no real socket, so getConnInfo falls back
  // to "unknown". All test requests therefore share the same IP bucket "unknown",
  // making this an exact per-IP rate-limit test.
  const { login } = await makeApp();
  for (let i = 0; i < LOGIN_MAX_FAILURES; i++) {
    expect((await login("bad")).res.status).toBe(401);
  }
  // The (MAX+1)th attempt must be throttled
  expect((await login("bad")).res.status).toBe(429);
});

test("trustProxy:false — forged XFF header does NOT create distinct IP buckets (socket addr used)", async () => {
  // With trustProxy=false, varied XFF values are ignored; all requests land in
  // the same "unknown" bucket. Spamming varied XFF values still trips the limit.
  const { login } = await makeApp({ trustProxy: false });
  for (let i = 0; i < LOGIN_MAX_FAILURES; i++) {
    // Use a different XFF value each time — should NOT create distinct buckets
    expect((await login("bad", `10.0.0.${i}`)).res.status).toBe(401);
  }
  // The next attempt (any XFF) must still be throttled because they all share "unknown"
  expect((await login("bad", "192.168.99.1")).res.status).toBe(429);
});

test("trustProxy:true — distinct XFF values create distinct IP buckets", async () => {
  // With trustProxy=true, different XFF values each get their own failure bucket.
  // An IP that hasn't hit its per-IP limit yet is NOT throttled (assuming we stay
  // under the global ceiling).
  const { login } = await makeApp({ trustProxy: true });

  // Exhaust the limit for IP "1.2.3.4"
  for (let i = 0; i < LOGIN_MAX_FAILURES; i++) {
    expect((await login("bad", "1.2.3.4")).res.status).toBe(401);
  }
  expect((await login("bad", "1.2.3.4")).res.status).toBe(429);

  // A different IP "5.6.7.8" has a fresh bucket — should still get 401, not 429
  expect((await login("bad", "5.6.7.8")).res.status).toBe(401);
});

test("global failure ceiling: cross-IP total failures trips 429 even on fresh IPs", async () => {
  // With trustProxy=true, once GLOBAL_MAX_FAILURES failures occur across all IPs,
  // the next attempt from a brand-new IP is blocked by the global ceiling.
  const { login } = await makeApp({ trustProxy: true });

  // Distribute failures across many distinct IPs so no per-IP limit triggers
  for (let i = 0; i < GLOBAL_MAX_FAILURES; i++) {
    const ip = `10.${Math.floor(i / 256)}.${i % 256}.1`;
    expect((await login("bad", ip)).res.status).toBe(401);
  }
  // Now a completely fresh IP should be blocked by the global ceiling
  expect((await login("bad", "99.99.99.99")).res.status).toBe(429);
});

test("successful login does NOT reset the per-IP failure counter", async () => {
  // Deliberate hardening: a success on a shared IP (NAT) must not launder away an
  // attacker's accumulated failures. Only window expiry resets the per-IP bucket.
  const { loginToken, login } = await makeApp({ trustProxy: true });
  const ip = "1.2.3.4";

  // Record (LOGIN_MAX_FAILURES - 1) failures: count climbs to MAX-1, all 401.
  for (let i = 0; i < LOGIN_MAX_FAILURES - 1; i++) {
    expect((await login("bad", ip)).res.status).toBe(401);
  }

  // One SUCCESSFUL login from the same IP. This does NOT clear the failure bucket.
  expect((await login(loginToken, ip)).res.status).toBe(200);

  // The off-by-one: isRateLimited checks count >= MAX *before* recording, and the
  // success left count at MAX-1 (not reset). So this failure still passes the gate
  // (MAX-1 < MAX) → 401, and recordFailure bumps count to MAX.
  expect((await login("bad", ip)).res.status).toBe(401);
  // The NEXT failure now sees count === MAX → 429. (Had the success reset the
  // bucket, this attempt would have been a fresh 401 instead.)
  expect((await login("bad", ip)).res.status).toBe(429);
});

test("instances: pairing token, list with online flag, account isolation, rpc stamping", async () => {
  const { app, instances, loginToken, login, rpcCalls } = await makeApp();
  const { cookie } = await login(loginToken);
  const tokenRes = await app.request("/api/instances/pairing-token", {
    method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ name: "pc" }),
  });
  expect(tokenRes.status).toBe(200);
  const { token } = (await tokenRes.json()) as { token: string };
  const redeemed = instances.redeemPairingToken(token)!;

  const listRes = await app.request("/api/instances", { headers: { cookie } });
  const { instances: listed } = (await listRes.json()) as { instances: Array<{ id: string; online: boolean }> };
  expect(listed[0]?.id).toBe(redeemed.instanceId);
  expect(listed[0]?.online).toBe(true);

  // rpc: stamps chatKey/senderId/isOwner server-side, ignoring client-supplied values
  const rpcRes = await app.request(`/api/instances/${redeemed.instanceId}/rpc`, {
    method: "POST", headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ type: MSG.prompt, payload: { chatKey: "forged", senderId: "forged", sessionAlias: "s", text: "hi" } }),
  });
  expect(rpcRes.status).toBe(200);
  const stamped = rpcCalls[0]?.payload as { chatKey: string; senderId: string; isOwner: boolean };
  expect(stamped.chatKey).toBe(`relay:${redeemed.accountId}`);
  expect(stamped.senderId).toBe(redeemed.accountId);
  expect(stamped.isOwner).toBe(true);

  // non-control types rejected; foreign instance 404
  expect((await app.request(`/api/instances/${redeemed.instanceId}/rpc`, {
    method: "POST", headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ type: "instance.register", payload: {} }),
  })).status).toBe(400);
  expect((await app.request(`/api/instances/not-mine/rpc`, {
    method: "POST", headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ type: MSG.sessionsList, payload: {} }),
  })).status).toBe(404);
});

test("PATCH /api/instances/:id renames an owned instance", async () => {
  const { app, instances, loginToken, login } = await makeApp();
  const { cookie } = await login(loginToken);
  const tokenRes = await app.request("/api/instances/pairing-token", {
    method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ name: "pc" }),
  });
  const { token } = (await tokenRes.json()) as { token: string };
  const { instanceId, accountId } = instances.redeemPairingToken(token)!;

  const res = await app.request(`/api/instances/${instanceId}`, {
    method: "PATCH", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ name: "renamed" }),
  });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true });
  expect(instances.getOwned(instanceId, accountId)?.name).toBe("renamed");
});

test("PATCH /api/instances/:id with an empty/whitespace name → 400 invalid-name", async () => {
  const { app, instances, loginToken, login } = await makeApp();
  const { cookie } = await login(loginToken);
  const tokenRes = await app.request("/api/instances/pairing-token", {
    method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ name: "pc" }),
  });
  const { token } = (await tokenRes.json()) as { token: string };
  const { instanceId } = instances.redeemPairingToken(token)!;

  const res = await app.request(`/api/instances/${instanceId}`, {
    method: "PATCH", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ name: "   " }),
  });
  expect(res.status).toBe(400);
  expect(((await res.json()) as { error: string }).error).toBe("invalid-name");
});

test("PATCH /api/instances/:id on a non-owned instance → 404 not-found", async () => {
  const { app, loginToken, login } = await makeApp();
  const { cookie } = await login(loginToken);
  const res = await app.request(`/api/instances/not-mine`, {
    method: "PATCH", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ name: "x" }),
  });
  expect(res.status).toBe(404);
  expect(((await res.json()) as { error: string }).error).toBe("not-found");
});

test("PATCH /api/instances/:id with a non-JSON content-type → 415", async () => {
  const { app, instances, loginToken, login } = await makeApp();
  const { cookie } = await login(loginToken);
  const tokenRes = await app.request("/api/instances/pairing-token", {
    method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ name: "pc" }),
  });
  const { token } = (await tokenRes.json()) as { token: string };
  const { instanceId } = instances.redeemPairingToken(token)!;

  const res = await app.request(`/api/instances/${instanceId}`, {
    method: "PATCH", headers: { cookie, "content-type": "text/plain" }, body: JSON.stringify({ name: "renamed" }),
  });
  expect(res.status).toBe(415);
});

test("rpc command.execute echoes input and output into history", async () => {
  const { app, instances, gateway, messages, loginToken, login } = await makeApp();
  const { cookie } = await login(loginToken);
  const tokenRes = await app.request("/api/instances/pairing-token", {
    method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ name: "pc" }),
  });
  const { token } = (await tokenRes.json()) as { token: string };
  const { instanceId, accountId } = instances.redeemPairingToken(token)!;

  (gateway as unknown as { sendRequest: () => Promise<unknown> }).sendRequest = async () => ({ output: "ran ok" });

  const res = await app.request(`/api/instances/${instanceId}/rpc`, {
    method: "POST", headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ type: MSG.commandExecute, payload: { sessionAlias: "s", text: "/status" } }),
  });
  expect(res.status).toBe(200);
  const cached = messages.listBySession(accountId, instanceId, "s");
  expect(cached.messages.map((m) => [m.direction, m.text])).toEqual([["in", "/status"], ["out", "ran ok"]]);
});

test("rpc prompt persists the inbound message before the turn's out message (history order)", async () => {
  const { app, instances, gateway, messages, loginToken, login } = await makeApp();
  const { cookie } = await login(loginToken);
  const tokenRes = await app.request("/api/instances/pairing-token", {
    method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ name: "pc" }),
  });
  const { token } = (await tokenRes.json()) as { token: string };
  const { instanceId, accountId } = instances.redeemPairingToken(token)!;

  // Real flow: the agent's turn-finished fires (appending "out") WHILE
  // sendRequest is still awaiting, before it resolves. Simulate that here.
  (gateway as unknown as { sendRequest: () => Promise<unknown> }).sendRequest = async () => {
    messages.append(instanceId, "s", "out", "agent reply");
    return {};
  };

  const res = await app.request(`/api/instances/${instanceId}/rpc`, {
    method: "POST", headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ type: MSG.prompt, payload: { sessionAlias: "s", text: "hi" } }),
  });
  expect(res.status).toBe(200);
  const cached = messages.listBySession(accountId, instanceId, "s");
  expect(cached.messages.map((m) => [m.direction, m.text])).toEqual([["in", "hi"], ["out", "agent reply"]]);
});

test("GET /api/config returns the retention policy from deps", async () => {
  const db = await createSqlDriver(":memory:");
  initSchema(db);
  const accounts = new AccountStore(db);
  const instances = new InstanceStore(db);
  const admin = accounts.createAccount("admin");
  const { token: loginToken } = accounts.createLoginToken(admin.id);
  const messages = new MessageStore(db);
  const gateway = {
    isOnline: () => true,
    sendRequest: async () => ({}),
  };
  const app = createApp({
    accounts, instances, gateway, messages,
    historyRetentionDays: 14, maxMessagesPerSession: 500,
  });
  const loginRes = await app.request("/api/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: loginToken }),
  });
  const cookie = loginRes.headers.get("set-cookie")?.split(";")[0] ?? "";
  const res = await app.request("/api/config", { headers: { cookie } });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ historyRetention: { days: 14, maxPerSession: 500 } });
});

test("pairing-token rejects non-JSON bodies with 415", async () => {
  const { app, loginToken, login } = await makeApp();
  const { cookie } = await login(loginToken);
  const res = await app.request("/api/instances/pairing-token", {
    method: "POST", headers: { cookie, "content-type": "text/plain" }, body: JSON.stringify({ name: "pc" }),
  });
  expect(res.status).toBe(415);
});

test("login rate-limiter: per-IP window expires and IP is no longer throttled", async () => {
  const db = await createSqlDriver(":memory:");
  initSchema(db);
  const accounts = new AccountStore(db);
  const instances = new InstanceStore(db);
  const messages = new MessageStore(db);
  const gateway = { isOnline: () => true, sendRequest: async () => ({}) };
  let clock = 0;
  // trustProxy:true so we can control the IP via XFF header
  const app = createApp({ accounts, instances, gateway, messages, now: () => new Date(clock), trustProxy: true });
  const fail = (xff?: string) =>
    app.request("/api/login", {
      method: "POST",
      headers: { "content-type": "application/json", ...(xff ? { "x-forwarded-for": xff } : {}) },
      body: JSON.stringify({ token: "bad-token" }),
    });

  const LOGIN_WINDOW_MS = 10 * 60 * 1000;
  const ip = "1.2.3.4";

  // T=0: drive "1.2.3.4" into the 429 state.
  for (let i = 0; i < LOGIN_MAX_FAILURES; i++) expect((await fail(ip)).status).toBe(401);
  expect((await fail(ip)).status).toBe(429); // window is "hot"

  // Advance past the window. The per-IP bucket resets here via its lazy window-check
  // (isRateLimited treats an entry whose windowStart is older than LOGIN_WINDOW_MS as
  // stale). Only ~LOGIN_MAX_FAILURES failures occurred, so the GLOBAL counter never
  // activated in this test; it would reset the same lazy way IF it had been active.
  clock += LOGIN_WINDOW_MS + 1;

  // "1.2.3.4" must now get a fresh 401 (not 429): its stale window no longer counts.
  expect((await fail(ip)).status).toBe(401);
  // And it takes the full LOGIN_MAX_FAILURES - 1 more failures before 429 again.
  for (let i = 1; i < LOGIN_MAX_FAILURES; i++) expect((await fail(ip)).status).toBe(401);
  expect((await fail(ip)).status).toBe(429);
});

test("rpc rejects non-JSON content-type (CSRF backstop) but accepts application/json", async () => {
  const { app, instances, loginToken, login, rpcCalls } = await makeApp();
  const { cookie } = await login(loginToken);
  const tokenRes = await app.request("/api/instances/pairing-token", {
    method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ name: "pc" }),
  });
  const { token } = (await tokenRes.json()) as { token: string };
  const { instanceId } = instances.redeemPairingToken(token)!;

  // text/plain simple-request is refused; gateway never called
  const bad = await app.request(`/api/instances/${instanceId}/rpc`, {
    method: "POST", headers: { cookie, "content-type": "text/plain" },
    body: JSON.stringify({ type: MSG.commandExecute, payload: { text: "/danger" } }),
  });
  expect(bad.status).toBe(415);
  expect(rpcCalls.length).toBe(0);

  // application/json works
  const ok = await app.request(`/api/instances/${instanceId}/rpc`, {
    method: "POST", headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ type: MSG.sessionsList, payload: {} }),
  });
  expect(ok.status).toBe(200);
  expect(rpcCalls.length).toBe(1);
});

// --- createRelayRuntime trustProxy wiring ---

test("createRelayRuntime trustProxy:true — the assembled app honors XFF header for rate-limiting", async () => {
  // This test verifies the wiring: createRelayRuntime({ trustProxy:true }) must
  // thread the flag through to createApp, so the resulting app treats distinct
  // X-Forwarded-For values as distinct rate-limit buckets.
  const dbPath = join(mkdtempSync(join(tmpdir(), "relay-rt-")), "relay.db");
  const runtime = await createRelayRuntime(dbPath, { trustProxy: true });
  try {
    // Create an admin account so we can attempt logins
    const admin = runtime.accounts.createAccount("rtadmin");
    void admin; // used only to seed the DB

    const failLogin = (xff: string) =>
      runtime.app.request("/api/login", {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": xff },
        body: JSON.stringify({ token: "bad-token" }),
      });

    // Exhaust the per-IP limit for "1.2.3.4"
    for (let i = 0; i < LOGIN_MAX_FAILURES; i++) {
      expect((await failLogin("1.2.3.4")).status).toBe(401);
    }
    expect((await failLogin("1.2.3.4")).status).toBe(429);

    // A different IP must still have a fresh bucket (not yet throttled)
    expect((await failLogin("5.6.7.8")).status).toBe(401);
  } finally {
    runtime.close();
  }
});

test("createRelayRuntime trustProxy:false (default) — XFF header is ignored, single bucket", async () => {
  // With trustProxy omitted (defaults to false), all requests share the same
  // "unknown" bucket regardless of XFF. Varied XFF values must NOT create
  // separate buckets; the global limit is still reached.
  const dbPath = join(mkdtempSync(join(tmpdir(), "relay-rt-")), "relay.db");
  const runtime = await createRelayRuntime(dbPath);  // trustProxy defaults to false
  try {
    runtime.accounts.createAccount("rtadmin2");

    const failLogin = (xff: string) =>
      runtime.app.request("/api/login", {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": xff },
        body: JSON.stringify({ token: "bad-token" }),
      });

    // Use a distinct XFF each time — they must all share the same "unknown" bucket
    for (let i = 0; i < LOGIN_MAX_FAILURES; i++) {
      expect((await failLogin(`10.0.0.${i}`)).status).toBe(401);
    }
    // Next attempt (new XFF) is blocked: shared bucket was exhausted
    expect((await failLogin("192.168.1.1")).status).toBe(429);
  } finally {
    runtime.close();
  }
});

test("GET /api/version default path reports current-only without throwing", async () => {
  const { app, loginToken, login } = await makeApp();
  const { cookie } = await login(loginToken);
  const res = await app.request("/api/version", { headers: { cookie } });
  expect(res.status).toBe(200);
  const body = await res.json() as { current: string; latest: string | null; updateAvailable: boolean };
  expect(typeof body.current).toBe("string");
  expect(body.latest).toBeNull();
  expect(body.updateAvailable).toBe(false);
});

test("GET /api/version returns the injected update check (auth required)", async () => {
  const db = await createSqlDriver(":memory:");
  initSchema(db);
  const accounts = new AccountStore(db);
  const instances = new InstanceStore(db);
  const admin = accounts.createAccount("admin");
  const { token } = accounts.createLoginToken(admin.id, "test");
  const messages = new MessageStore(db);
  const gateway = { isOnline: () => true, sendRequest: async () => ({}) };
  const app = createApp({
    accounts, instances, gateway, messages,
    checkUpdate: async () => ({ current: "0.6.0", latest: "0.7.0", updateAvailable: true }),
  });
  // unauthenticated → 401
  expect((await app.request("/api/version")).status).toBe(401);
  // authenticated → the injected payload
  const login = await app.request("/api/login", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }),
  });
  const cookie = login.headers.get("set-cookie")?.split(";")[0] ?? "";
  const res = await app.request("/api/version", { headers: { cookie } });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ current: "0.6.0", latest: "0.7.0", updateAvailable: true });
});
