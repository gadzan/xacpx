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
  expect(cached.messages.map((m) => [m.direction, m.text])).toEqual([["in", "do it"]]);
  runtime.close();
});

test("delete then same-alias create returns an empty Web history", async () => {
  const { runtime, cookie } = await loggedIn();
  (runtime.gateway as unknown as { sendRequest: () => Promise<unknown> }).sendRequest = async () => ({ ok: true });
  runtime.messages.append("i1", "backend", "in", "old question");
  runtime.messages.append("i1", "backend", "out", "old answer");

  const remove = await runtime.app.request("/api/instances/i1/rpc", {
    method: "POST", headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ type: MSG.sessionsRemove, payload: { alias: "backend" } }),
  });
  expect(remove.status).toBe(200);
  const create = await runtime.app.request("/api/instances/i1/rpc", {
    method: "POST", headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ type: MSG.sessionsCreate, payload: { alias: "backend", agent: "claude", workspace: "home" } }),
  });
  expect(create.status).toBe(200);

  const history = await runtime.app.request("/api/instances/i1/sessions/backend/messages", { headers: { cookie } });
  expect(await history.json()).toEqual({ messages: [], hasMore: false });
  runtime.close();
});

test("failed delete and archive both preserve Web history", async () => {
  const { runtime, cookie } = await loggedIn();
  (runtime.gateway as unknown as { sendRequest: (_id: string, type: string) => Promise<unknown> }).sendRequest = async (_id, type) =>
    type === MSG.sessionsRemove
      ? { error: { code: "delete-failed", message: "still active" } }
      : { ok: true };
  runtime.messages.append("i1", "backend", "in", "keep me");

  await runtime.app.request("/api/instances/i1/rpc", {
    method: "POST", headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ type: MSG.sessionsArchive, payload: { alias: "backend" } }),
  });
  await runtime.app.request("/api/instances/i1/rpc", {
    method: "POST", headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ type: MSG.sessionsRemove, payload: { alias: "backend" } }),
  });

  const history = await runtime.app.request("/api/instances/i1/sessions/backend/messages", { headers: { cookie } });
  const body = (await history.json()) as { messages: Array<{ text: string }> };
  expect(body.messages.map((message) => message.text)).toEqual(["keep me"]);
  runtime.close();
});

test("a late delete response cannot purge messages from a recreated same-alias session", async () => {
  const { runtime, cookie } = await loggedIn();
  let releaseRemove!: () => void;
  const removeBlocked = new Promise<void>((resolve) => {
    releaseRemove = resolve;
  });
  let markRemoveStarted!: () => void;
  const removeStarted = new Promise<void>((resolve) => {
    markRemoveStarted = resolve;
  });
  (runtime.gateway as unknown as { sendRequest: (_id: string, type: string) => Promise<unknown> }).sendRequest = async (_id, type) => {
    if (type === MSG.sessionsRemove) {
      markRemoveStarted();
      await removeBlocked;
    }
    return { ok: true };
  };
  runtime.messages.append("i1", "backend", "in", "old question");

  const remove = runtime.app.request("/api/instances/i1/rpc", {
    method: "POST", headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ type: MSG.sessionsRemove, payload: { alias: "backend" } }),
  });
  await removeStarted;
  const prompt = runtime.app.request("/api/instances/i1/rpc", {
    method: "POST", headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ type: MSG.prompt, payload: { sessionAlias: "backend", text: "new question" } }),
  });
  await Bun.sleep(0);
  releaseRemove();
  await Promise.all([remove, prompt]);

  const history = runtime.messages.listBySession(
    runtime.accounts.findByUsername("admin")!.id,
    "i1",
    "backend",
  );
  expect(history.messages.map((message) => message.text)).toEqual(["new question"]);
  runtime.close();
});
