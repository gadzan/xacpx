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
  const { messages, hasMore } = store.listBySession("a1", "i1", "backend");
  expect(messages[0]).toMatchObject({ direction: "out", text: "answer" });
  expect(messages[0].structured).toEqual(structured);
  expect(typeof messages[0].id).toBe("number"); // cursor id exposed
  expect(hasMore).toBe(false);
  db.close();
});

test("append without structured yields no structured field", async () => {
  const db = await seeded();
  const store = new MessageStore(db);
  store.append("i1", "backend", "in", "hi");
  const { messages } = store.listBySession("a1", "i1", "backend");
  expect(messages[0].structured).toBeUndefined();
  db.close();
});

test("persists and returns attachment metadata on inbound messages", async () => {
  const db = await seeded();
  const store = new MessageStore(db);
  const atts = [{ id: "u-1", filename: "shot.png", mimeType: "image/png", size: 3, kind: "image" as const, previewUrl: "data:image/png;base64,AAAA" }];
  store.append("i1", "main", "in", "look", undefined, atts);
  const page = store.listBySession("a1", "i1", "main");
  expect(page.messages.at(-1)?.attachments).toEqual(atts);
  db.close();
});

test("listBySession paginates oldest-first with a `before` cursor and hasMore", async () => {
  const db = await seeded();
  const store = new MessageStore(db);
  for (let i = 1; i <= 5; i++) store.append("i1", "backend", "in", `m${i}`);

  // Most recent 2 rows (oldest-first within the page), and there's older history.
  const page1 = store.listBySession("a1", "i1", "backend", { limit: 2 });
  expect(page1.messages.map((m) => m.text)).toEqual(["m4", "m5"]);
  expect(page1.hasMore).toBe(true);

  // Load older: the 2 rows immediately before the oldest id we have (m4).
  const page2 = store.listBySession("a1", "i1", "backend", { limit: 2, before: page1.messages[0]!.id });
  expect(page2.messages.map((m) => m.text)).toEqual(["m2", "m3"]);
  expect(page2.hasMore).toBe(true);

  // The final older page exhausts history → hasMore false.
  const page3 = store.listBySession("a1", "i1", "backend", { limit: 2, before: page2.messages[0]!.id });
  expect(page3.messages.map((m) => m.text)).toEqual(["m1"]);
  expect(page3.hasMore).toBe(false);
  db.close();
});
