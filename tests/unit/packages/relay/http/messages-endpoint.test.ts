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

test("a queued prompt is persisted where it drains, after the previous turn reply", async () => {
  const { runtime, cookie } = await loggedIn();
  const accountId = runtime.accounts.findByUsername("admin")!.id;
  const fire = (event: unknown) => runtime.gateway["deps"].onEvent!("i1", accountId, {
    protocolVersion: 1, kind: "event", type: MSG.instanceEvent, payload: { event },
  });
  fire({ type: "turn-started", chatKey: `relay:${accountId}`, sessionAlias: "backend" });
  (runtime.gateway as unknown as { sendRequest: () => Promise<unknown> }).sendRequest = async () => {
    fire({ type: "turn-output", chatKey: `relay:${accountId}`, sessionAlias: "backend", chunk: "first reply" });
    fire({ type: "turn-finished", chatKey: `relay:${accountId}`, sessionAlias: "backend", ok: true });
    return { ok: true, queued: true, queueItemId: "q1" };
  };

  await runtime.app.request("/api/instances/i1/rpc", {
    method: "POST", headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ type: MSG.prompt, payload: { sessionAlias: "backend", text: "queued prompt" } }),
  });
  fire({ type: "turn-started", chatKey: `relay:${accountId}`, sessionAlias: "backend", queueItemId: "q1", prompt: "queued prompt" });
  fire({ type: "turn-output", chatKey: `relay:${accountId}`, sessionAlias: "backend", chunk: "second reply" });
  fire({ type: "turn-finished", chatKey: `relay:${accountId}`, sessionAlias: "backend", ok: true });

  const cached = runtime.messages.listBySession(accountId, "i1", "backend");
  expect(cached.messages.map((message) => [message.direction, message.text])).toEqual([
    ["out", "first reply"],
    ["in", "queued prompt"],
    ["out", "second reply"],
  ]);
  runtime.close();
});

test("queued history reconciles when turn-started races ahead of the prompt response", async () => {
  const { runtime, cookie } = await loggedIn();
  const accountId = runtime.accounts.findByUsername("admin")!.id;
  const fire = (event: unknown) => runtime.gateway["deps"].onEvent!("i1", accountId, {
    protocolVersion: 1, kind: "event", type: MSG.instanceEvent, payload: { event },
  });
  fire({ type: "turn-started", chatKey: `relay:${accountId}`, sessionAlias: "backend" });
  (runtime.gateway as unknown as { sendRequest: () => Promise<unknown> }).sendRequest = async () => {
    fire({ type: "turn-output", chatKey: `relay:${accountId}`, sessionAlias: "backend", chunk: "first reply" });
    fire({ type: "turn-finished", chatKey: `relay:${accountId}`, sessionAlias: "backend", ok: true });
    fire({ type: "turn-started", chatKey: `relay:${accountId}`, sessionAlias: "backend", queueItemId: "q1", prompt: "queued prompt" });
    fire({ type: "turn-output", chatKey: `relay:${accountId}`, sessionAlias: "backend", chunk: "second reply" });
    fire({ type: "turn-finished", chatKey: `relay:${accountId}`, sessionAlias: "backend", ok: true });
    return { ok: true, queued: true, queueItemId: "q1" };
  };

  await runtime.app.request("/api/instances/i1/rpc", {
    method: "POST", headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ type: MSG.prompt, payload: { sessionAlias: "backend", text: "queued prompt" } }),
  });

  const cached = runtime.messages.listBySession(accountId, "i1", "backend");
  expect(cached.messages.map((message) => [message.direction, message.text])).toEqual([
    ["out", "first reply"],
    ["in", "queued prompt"],
    ["out", "second reply"],
  ]);
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

test("GET messages?view=compact strips bulky tool details; GET :id returns the full row", async () => {
  const { runtime, cookie } = await loggedIn();
  const structured = {
    toolSteps: [{
      toolCallId: "t1",
      toolName: "Read",
      kind: "read" as const,
      status: "success" as const,
      title: "a.ts",
      detail: { type: "read" as const, path: "a.ts", preview: "const x = 1;\n".repeat(20) },
    }],
    parts: [
      { type: "text" as const, text: "looked" },
      {
        type: "tool" as const,
        step: {
          toolCallId: "t1",
          toolName: "Read",
          kind: "read" as const,
          status: "success" as const,
          title: "a.ts",
          detail: { type: "read" as const, path: "a.ts", preview: "const x = 1;\n".repeat(20) },
        },
      },
    ],
  };
  runtime.messages.append("i1", "backend", "out", "looked", structured);
  const listed = await runtime.app.request("/api/instances/i1/sessions/backend/messages?view=compact", { headers: { cookie } });
  const page = (await listed.json()) as { messages: Array<{ id: number; structured?: { compact?: boolean; toolSteps?: unknown; parts?: Array<{ type: string; step?: { detail?: { preview?: string; path?: string } } }> } }> };
  expect(page.messages).toHaveLength(1);
  expect(page.messages[0]?.structured?.compact).toBe(true);
  expect(page.messages[0]?.structured?.toolSteps).toBeUndefined();
  const tool = page.messages[0]?.structured?.parts?.find((p) => p.type === "tool");
  expect(tool?.step?.detail?.preview).toBeUndefined();
  expect(tool?.step?.detail?.path).toBe("a.ts");

  const full = await runtime.app.request(`/api/instances/i1/sessions/backend/messages/${page.messages[0]!.id}`, { headers: { cookie } });
  const body = (await full.json()) as { message: { structured?: { compact?: boolean; parts?: Array<{ type: string; step?: { detail?: { preview?: string } } }> } } };
  expect(body.message.structured?.compact).toBeUndefined();
  const fullTool = body.message.structured?.parts?.find((p) => p.type === "tool");
  expect(fullTool?.step?.detail?.preview).toContain("const x = 1;");
  runtime.close();
});

test("GET messages without view=compact still returns full structured rows", async () => {
  const { runtime, cookie } = await loggedIn();
  runtime.messages.append("i1", "backend", "out", "looked", {
    toolSteps: [{
      toolCallId: "t1",
      toolName: "Read",
      kind: "read",
      status: "success",
      title: "a.ts",
      detail: { type: "read", path: "a.ts", preview: "full preview" },
    }],
  });
  const res = await runtime.app.request("/api/instances/i1/sessions/backend/messages", { headers: { cookie } });
  const page = (await res.json()) as { messages: Array<{ structured?: { compact?: boolean; toolSteps?: Array<{ detail?: { preview?: string } }> } }> };
  expect(page.messages[0]?.structured?.compact).toBeUndefined();
  expect(page.messages[0]?.structured?.toolSteps?.[0]?.detail?.preview).toBe("full preview");
  runtime.close();
});

test("GET messages?view=compact keeps startedAt and slotAfterId on the assistant out row", async () => {
  const { runtime, cookie } = await loggedIn();
  runtime.messages.append("i1", "backend", "out", "looked", undefined, undefined, undefined, undefined, 1_700_000_000_000, 4, 2);
  const listed = await runtime.app.request("/api/instances/i1/sessions/backend/messages?view=compact", { headers: { cookie } });
  const page = (await listed.json()) as { messages: Array<{ startedAt?: number; slotAfterId?: number; startedAfterSeq?: number; text: string }> };
  expect(page.messages).toHaveLength(1);
  expect(page.messages[0]?.text).toBe("looked");
  expect(page.messages[0]?.startedAt).toBe(1_700_000_000_000);
  expect(page.messages[0]?.slotAfterId).toBe(4);
  expect(page.messages[0]?.startedAfterSeq).toBe(2);

  const full = await runtime.app.request("/api/instances/i1/sessions/backend/messages", { headers: { cookie } });
  const body = (await full.json()) as { messages: Array<{ startedAt?: number; slotAfterId?: number; startedAfterSeq?: number }> };
  expect(body.messages[0]?.startedAt).toBe(1_700_000_000_000);
  expect(body.messages[0]?.slotAfterId).toBe(4);
  expect(body.messages[0]?.startedAfterSeq).toBe(2);
  runtime.close();
});

test("GET a missing message id is 404", async () => {
  const { runtime, cookie } = await loggedIn();
  const res = await runtime.app.request("/api/instances/i1/sessions/backend/messages/99", { headers: { cookie } });
  expect(res.status).toBe(404);
  runtime.close();
});
