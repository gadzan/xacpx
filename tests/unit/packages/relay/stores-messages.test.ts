// History retirement: the hub transcript is an ephemeral memory ring.
// These tests pin the MemoryMessageStore contract that server.ts programs
// against (same observable semantics the SQLite store used to provide,
// minus cross-process durability and account-ownership enforcement — the
// latter is the caller's job now, see listBySession's doc comment).
import { expect, test } from "bun:test";
import { MemoryMessageStore } from "../../../../packages/relay/src/stores/messages-memory";

test("append + listBySession round-trips structured data", async () => {
  const store = new MemoryMessageStore();
  const structured = { toolSteps: [{ toolCallId: "t1", toolName: "Read", kind: "read", status: "success", title: "a.ts" }], reasoning: "thought" };
  store.append("i1", "backend", "out", "answer", structured as never);
  const { messages, hasMore } = store.listBySession("a1", "i1", "backend");
  expect(messages[0]).toMatchObject({ direction: "out", text: "answer" });
  expect(messages[0].structured).toEqual(structured);
  expect(typeof messages[0].id).toBe("number"); // cursor id exposed
  expect(hasMore).toBe(false);
});

test("append without structured yields no structured field", async () => {
  const store = new MemoryMessageStore();
  store.append("i1", "backend", "in", "hi");
  const { messages } = store.listBySession("a1", "i1", "backend");
  expect(messages[0].structured).toBeUndefined();
});

test("persists and returns attachment metadata on inbound messages", async () => {
  const store = new MemoryMessageStore();
  const atts = [{ id: "u-1", filename: "shot.png", mimeType: "image/png", size: 3, kind: "image" as const, previewUrl: "data:image/png;base64,AAAA" }];
  store.append("i1", "main", "in", "look", undefined, atts);
  const page = store.listBySession("a1", "i1", "main");
  expect(page.messages.at(-1)?.attachments).toEqual(atts);
});

test("listBySession paginates oldest-first with a `before` cursor and hasMore", async () => {
  const store = new MemoryMessageStore();
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
});

test("getById returns one session-scoped row or null", async () => {
  const store = new MemoryMessageStore();
  store.append("i1", "backend", "out", "answer", { reasoning: "thought" } as never);
  const listed = store.listBySession("a1", "i1", "backend").messages[0]!;
  expect(store.getById("a1", "i1", "backend", listed.id!).structured).toEqual({ reasoning: "thought" });
  expect(store.getById("a1", "i1", "other", listed.id!)).toBeNull();
});

test("rows are isolated by session; account scoping is the caller's job", async () => {
  const store = new MemoryMessageStore();
  store.append("i1", "backend", "in", "secret");
  // Same instance, different session → nothing.
  expect(store.listBySession("a1", "i1", "other").messages).toEqual([]);
  // NOTE: unlike the retired SQLite store (JOIN on instances for ownership),
  // the memory store cannot verify account ownership — server.ts / app.ts pass
  // an already-authorized pair via getOwned. Same pair, any account → rows.
  expect(store.listBySession("a2", "i1", "backend").messages.map((m) => m.text)).toEqual(["secret"]);
});

test("attachNodeId stamps the pre-written inbound row by prompt request", async () => {
  const store = new MemoryMessageStore();
  store.append("i1", "backend", "in", "question", undefined, undefined, "pr-1");
  store.attachNodeId("i1", "backend", "node-1", { promptRequestId: "pr-1" });
  const [row] = store.listBySession("a1", "i1", "backend").messages;
  expect(row).toMatchObject({ direction: "in", text: "question", nodeId: "node-1" });
});

test("attachNodeId follows a queued prompt through promotion by queue id", async () => {
  const store = new MemoryMessageStore();
  const rowId = store.append("i1", "backend", "in", "queued question");
  store.markQueued(rowId, { instanceId: "i1", sessionAlias: "backend", queueItemId: "q-1" });
  store.promoteQueued({ instanceId: "i1", sessionAlias: "backend", queueItemId: "q-1" });
  store.attachNodeId("i1", "backend", "node-q", { queueItemId: "q-1" });
  const [row] = store.listBySession("a1", "i1", "backend").messages;
  expect(row?.nodeId).toBe("node-q");
});

test("attachNodeId without a correlation stamps the newest inbound row only when it is unstamped", async () => {
  const store = new MemoryMessageStore();
  store.append("i1", "backend", "in", "first");
  store.attachNodeId("i1", "backend", "node-first");
  store.append("i1", "backend", "in", "second");
  store.attachNodeId("i1", "backend", "node-second");
  // A later duplicate with no correlation must not rename an existing stamp.
  store.attachNodeId("i1", "backend", "node-late-duplicate");
  const rows = store.listBySession("a1", "i1", "backend").messages;
  expect(rows.map((row) => [row.text, row.nodeId])).toEqual([
    ["first", "node-first"],
    ["second", "node-second"],
  ]);
});

test("attachNodeId stamps a peer sender-card row by its agent message id", async () => {
  const store = new MemoryMessageStore();
  // `agent-message` appends the row without a prompt_request_id; the peer card's
  // messageId inside the structured payload is its only durable correlation.
  store.append("i1", "backend", "in", "schema changed", {
    agentMessage: {
      kind: "agent_message",
      direction: "received",
      messageId: "msg-peer-1",
      conversationId: "conv-1",
      peer: { handle: "agent:n1:sender", displayName: "Sender", agent: "codex" },
      content: "schema changed",
      createdAt: 1_000,
      status: "delivered",
    },
  });
  store.attachNodeId("i1", "backend", "node-peer", { peerMessageId: "msg-peer-1" });
  const [row] = store.listBySession("a1", "i1", "backend").messages;
  expect(row).toMatchObject({ direction: "in", text: "schema changed", nodeId: "node-peer" });
});

test("ring cap evicts oldest-first and ids stay increasing", async () => {
  const store = new MemoryMessageStore();
  const ids: number[] = [];
  for (let i = 0; i < 600; i++) ids.push(store.append("i1", "backend", "in", `m${i}`));
  const { messages } = store.listBySession("a1", "i1", "backend", { limit: 1000 });
  expect(messages.length).toBeLessThanOrEqual(500);
  expect(messages[0]!.text).toBe(`m${600 - messages.length}`);
  for (let i = 1; i < ids.length; i++) expect(ids[i]! > ids[i - 1]!).toBe(true);
});

test("ids from separate store instances (boots) order by time and rarely collide", async () => {
  // Boot bases are second-ordered with a random offset (see
  // MEMORY_BOOT_ID_STRIDE): boots a second apart order by boot time, and
  // same-second boots share only a random slice of a 4M-wide space.
  const a = new MemoryMessageStore(() => new Date(1_700_000_000_000));
  const b = new MemoryMessageStore(() => new Date(1_700_000_001_000));
  const idA = a.append("i1", "backend", "in", "boot-a");
  const idB = b.append("i1", "backend", "in", "boot-b");
  expect(idB).toBeGreaterThan(idA);
  // Within a boot ids stay strictly increasing regardless of the random base.
  const idB2 = b.append("i1", "backend", "in", "boot-b2");
  expect(idB2).toBe(idB + 1);
});
