// tests/unit/packages/relay/stores/messages.test.ts
import { expect, test } from "bun:test";
import { createSqlDriver, initSchema } from "../../../../../packages/relay/src/db";
import { MessageStore } from "../../../../../packages/relay/src/stores/messages";

async function freshDb() {
  const db = await createSqlDriver(":memory:");
  initSchema(db);
  db.run("INSERT INTO accounts (id, username, created_at) VALUES (?,?,?)", ["a1", "u1", "t"]);
  db.run("INSERT INTO accounts (id, username, created_at) VALUES (?,?,?)", ["a2", "u2", "t"]);
  db.run("INSERT INTO instances (id, account_id, name, credential_hash, created_at) VALUES (?,?,?,?,?)", ["i1", "a1", "pc", "h", "t"]);
  db.run("INSERT INTO instances (id, account_id, name, credential_hash, created_at) VALUES (?,?,?,?,?)", ["i2", "a2", "pc", "h", "t"]);
  return db;
}

test("append then listBySession returns rows oldest-first as DTOs", async () => {
  const db = await freshDb();
  let clock = 1000;
  const store = new MessageStore(db, () => new Date(clock));
  store.append("i1", "backend", "in", "hello");
  clock = 2000;
  store.append("i1", "backend", "out", "world");
  const rows = store.listBySession("a1", "i1", "backend").messages;
  expect(rows.map((r) => [r.direction, r.text])).toEqual([["in", "hello"], ["out", "world"]]);
  expect(rows[0]?.instanceId).toBe("i1");
  expect(rows[0]?.createdAt).toBe(new Date(1000).toISOString());
});

test("listBySession is account-scoped: foreign account sees nothing", async () => {
  const db = await freshDb();
  const store = new MessageStore(db);
  store.append("i1", "backend", "in", "secret");
  expect(store.listBySession("a2", "i1", "backend").messages).toEqual([]);
});

test("listBySession honors the limit, keeping the most recent", async () => {
  const db = await freshDb();
  let clock = 0;
  const store = new MessageStore(db, () => new Date((clock += 1000)));
  for (let i = 0; i < 5; i++) store.append("i1", "backend", "in", `m${i}`);
  const rows = store.listBySession("a1", "i1", "backend", { limit: 2 }).messages;
  expect(rows.map((r) => r.text)).toEqual(["m3", "m4"]);
});

test("deleteBySession removes only the targeted instance and alias history", async () => {
  const db = await freshDb();
  const store = new MessageStore(db);
  store.append("i1", "backend", "in", "old question");
  store.append("i1", "backend", "out", "old answer");
  store.append("i1", "other", "in", "keep alias");
  store.append("i2", "backend", "in", "keep instance");

  expect(store.deleteBySession("i1", "backend")).toBe(2);
  expect(store.listBySession("a1", "i1", "backend").messages).toEqual([]);
  expect(store.listBySession("a1", "i1", "other").messages.map((m) => m.text)).toEqual(["keep alias"]);
  expect(store.listBySession("a2", "i2", "backend").messages.map((m) => m.text)).toEqual(["keep instance"]);
});

test("append stores structured agentMessage metadata and custom createdAt", async () => {
  const db = await freshDb();
  const store = new MessageStore(db);
  const agentMsg = {
    kind: "agent_message" as const,
    direction: "sent" as const,
    messageId: "msg_abc",
    conversationId: "conv_xyz",
    peer: {
      handle: "agent:node_b:worker_1",
      displayName: "Backend Worker",
      agent: "claude",
      workspace: "server",
    },
    content: "Database schema updated.",
    createdAt: 1771234567890,
    status: "sent" as const,
  };
  const customIso = new Date(1771234567890).toISOString();
  store.append("i1", "backend", "out", agentMsg.content, { agentMessage: agentMsg }, undefined, undefined, customIso);
  const rows = store.listBySession("a1", "i1", "backend").messages;
  expect(rows.length).toBe(1);
  expect(rows[0]?.direction).toBe("out");
  expect(rows[0]?.text).toBe("Database schema updated.");
  expect(rows[0]?.createdAt).toBe(customIso);
  expect(rows[0]?.structured?.agentMessage).toEqual(agentMsg);
});
