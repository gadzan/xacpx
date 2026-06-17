import { expect, test } from "bun:test";
import { createSqlDriver, initSchema } from "../../../../packages/relay/src/db";
import { MessageStore } from "../../../../packages/relay/src/stores/messages";

async function seeded() {
  const db = await createSqlDriver(":memory:");
  initSchema(db);
  db.run("INSERT INTO accounts (id, username, created_at) VALUES (?,?,?)", ["a1", "u", "t"]);
  db.run("INSERT INTO instances (id, account_id, name, credential_hash, created_at) VALUES (?,?,?,?,?)", ["i1", "a1", "pc", "h", "t"]);
  return db;
}

test("append + listBySession round-trips structured data", async () => {
  const db = await seeded();
  const store = new MessageStore(db);
  const structured = { toolSteps: [{ toolCallId: "t1", toolName: "Read", kind: "read", status: "success", title: "a.ts" }], reasoning: "thought" };
  store.append("i1", "backend", "out", "answer", structured as never);
  const rows = store.listBySession("a1", "i1", "backend");
  expect(rows[0]).toMatchObject({ direction: "out", text: "answer" });
  expect(rows[0].structured).toEqual(structured);
  db.close();
});

test("append without structured yields no structured field", async () => {
  const db = await seeded();
  const store = new MessageStore(db);
  store.append("i1", "backend", "in", "hi");
  const rows = store.listBySession("a1", "i1", "backend");
  expect(rows[0].structured).toBeUndefined();
  db.close();
});
