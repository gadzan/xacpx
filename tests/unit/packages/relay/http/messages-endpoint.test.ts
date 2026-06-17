// tests/unit/packages/relay/http/messages-endpoint.test.ts
import { expect, test } from "bun:test";
import { MSG } from "../../../../../packages/relay-protocol/src/index";
import { createRelayRuntime } from "../../../../../packages/relay/src/server";

async function loggedIn() {
  const runtime = await createRelayRuntime(":memory:");
  const account = runtime.accounts.createAccount("admin");
  const { token: loginToken } = runtime.accounts.createLoginToken(account.id);
  const res = await runtime.app.request("/api/login", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: loginToken }),
  });
  const cookie = res.headers.get("set-cookie")?.split(";")[0] ?? "";
  runtime.db.run("INSERT INTO instances (id, account_id, name, credential_hash, created_at) VALUES (?,?,?,?,?)", ["i1", account.id, "pc", "h", "t"]);
  return { runtime, cookie };
}

test("GET messages returns cached history for an owned session", async () => {
  const { runtime, cookie } = await loggedIn();
  runtime.messages.append("i1", "backend", "in", "hi");
  runtime.messages.append("i1", "backend", "out", "hello");
  const res = await runtime.app.request("/api/instances/i1/sessions/backend/messages", { headers: { cookie } });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { messages: Array<{ direction: string; text: string }> };
  expect(body.messages.map((m) => [m.direction, m.text])).toEqual([["in", "hi"], ["out", "hello"]]);
  runtime.close();
});

test("GET messages for an unowned instance is 404", async () => {
  const { runtime, cookie } = await loggedIn();
  const res = await runtime.app.request("/api/instances/ghost/sessions/backend/messages", { headers: { cookie } });
  expect(res.status).toBe(404);
  runtime.close();
});

test("rpc prompt echoes the user message into history", async () => {
  const { runtime, cookie } = await loggedIn();
  (runtime.gateway as unknown as { sendRequest: () => Promise<unknown> }).sendRequest = async () => ({ ok: true });
  await runtime.app.request("/api/instances/i1/rpc", {
    method: "POST", headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ type: MSG.prompt, payload: { sessionAlias: "backend", text: "do it" } }),
  });
  const cached = runtime.messages.listBySession(runtime.accounts.findByUsername("admin")!.id, "i1", "backend");
  expect(cached.map((m) => [m.direction, m.text])).toEqual([["in", "do it"]]);
  runtime.close();
});
