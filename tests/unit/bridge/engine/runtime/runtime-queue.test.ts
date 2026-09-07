import { expect, test } from "bun:test";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { RuntimeQueueStore, RUNTIME_QUEUE_MAX_DEPTH } from "../../../../../src/bridge/engine/runtime/runtime-queue";

async function withQueue(run: (store: RuntimeQueueStore, dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "rqueue-"));
  try {
    const store = new RuntimeQueueStore(dir);
    await run(store, dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("FIFO order preserved", async () => {
  await withQueue(async (store) => {
    await store.enqueue("sess1", { messageId: "a", text: "first", mode: "queue" });
    await store.enqueue("sess1", { messageId: "b", text: "second", mode: "queue" });
    await store.enqueue("sess1", { messageId: "c", text: "third", mode: "auto" });
    const rec = await store.load("sess1");
    expect(rec?.items.map((i) => i.messageId)).toEqual(["a", "b", "c"]);
  });
});

test("ack only after durable write", async () => {
  await withQueue(async (store, dir) => {
    const receipt = await store.enqueue("sess1", { messageId: "m1", text: "hello", mode: "queue" });
    expect(receipt.status).toBe("queued");
    const content = await readFile(join(dir, `${encodeURIComponent("sess1")}.json`), "utf8");
    const parsed = JSON.parse(content);
    expect(parsed.items[0].messageId).toBe("m1");
  });
});

test("write failure rejects — inject does not ack if dir unreadable (simulated by corrupt file)", async () => {
  await withQueue(async (store, dir) => {
    await writeFile(join(dir, `${encodeURIComponent("sess1")}.json`), "{ not json", "utf8");
    try {
      await store.enqueue("sess1", { messageId: "m1", text: "hi", mode: "queue" });
      throw new Error("expected enqueue to fail");
    } catch (err) {
      expect((err as { code?: string }).code).toBe("RUNTIME_INIT_FAILED");
    }
  });
});

test("corrupt journal fail-closed", async () => {
  await withQueue(async (store, dir) => {
    await writeFile(join(dir, `${encodeURIComponent("sess1")}.json`), JSON.stringify({ schema: "wrong", logicalSessionId: "sess1", items: [] }), "utf8");
    try {
      await store.load("sess1");
      throw new Error("expected load to fail");
    } catch (err) {
      expect((err as { code?: string }).code).toBe("RUNTIME_INIT_FAILED");
    }
    try {
      await store.enqueue("sess1", { messageId: "m1", text: "hi", mode: "queue" });
      throw new Error("expected enqueue to fail");
    } catch (err) {
      expect((err as { code?: string }).code).toBe("RUNTIME_INIT_FAILED");
    }
  });
});

test("duplicate id same payload is idempotent", async () => {
  await withQueue(async (store) => {
    const r1 = await store.enqueue("sess1", { messageId: "dup", text: "payload", mode: "queue" });
    const r2 = await store.enqueue("sess1", { messageId: "dup", text: "payload", mode: "queue" });
    expect(r1.queueItemId).toBe("dup");
    expect(r2.queueItemId).toBe("dup");
    const rec = await store.load("sess1");
    expect(rec?.items.length).toBe(1);
  });
});

test("duplicate id conflicting payload fails closed", async () => {
  await withQueue(async (store) => {
    await store.enqueue("sess1", { messageId: "dup", text: "payload1", mode: "queue" });
    try {
      await store.enqueue("sess1", { messageId: "dup", text: "payload2", mode: "queue" });
      throw new Error("expected conflict");
    } catch (err) {
      expect((err as { code?: string }).code).toBe("RUNTIME_QUEUE_CONFLICT");
    }
    const rec = await store.load("sess1");
    expect(rec?.items.length).toBe(1);
    expect(rec?.items[0]?.text).toBe("payload1");
  });
});

test("overflow parity: QUEUE_MAX_DEPTH rejects with RUNTIME_QUEUE_OVERFLOW", async () => {
  await withQueue(async (store) => {
    for (let i = 0; i < RUNTIME_QUEUE_MAX_DEPTH; i++) {
      await store.enqueue("sess1", { messageId: `m${i}`, text: `text${i}`, mode: "queue" });
    }
    try {
      await store.enqueue("sess1", { messageId: "overflow", text: "boom", mode: "queue" });
      throw new Error("expected overflow");
    } catch (err) {
      expect((err as { code?: string }).code).toBe("RUNTIME_QUEUE_OVERFLOW");
    }
    expect(await store.queueLength("sess1")).toBe(RUNTIME_QUEUE_MAX_DEPTH);
  });
});

test("dequeueHead atomically removes head and deletes file when empty", async () => {
  await withQueue(async (store, dir) => {
    await store.enqueue("sess1", { messageId: "a", text: "first", mode: "queue" });
    await store.enqueue("sess1", { messageId: "b", text: "second", mode: "queue" });
    const head = await store.dequeueHead("sess1");
    expect(head?.messageId).toBe("a");
    let rec = await store.load("sess1");
    expect(rec?.items.map((i) => i.messageId)).toEqual(["b"]);
    await store.dequeueHead("sess1");
    rec = await store.load("sess1");
    expect(rec).toBeUndefined();
    await expect(readFile(join(dir, `${encodeURIComponent("sess1")}.json`), "utf8")).rejects.toThrow();
  });
});

test("different sessions independent", async () => {
  await withQueue(async (store) => {
    await store.enqueue("sessA", { messageId: "m1", text: "a1", mode: "queue" });
    await store.enqueue("sessB", { messageId: "m1", text: "b1", mode: "queue" });
    expect(await store.queueLength("sessA")).toBe(1);
    expect(await store.queueLength("sessB")).toBe(1);
    await store.dequeueHead("sessA");
    expect(await store.queueLength("sessA")).toBe(0);
    expect(await store.queueLength("sessB")).toBe(1);
  });
});

test("listLogicalSessionIds enumerates journals", async () => {
  await withQueue(async (store) => {
    await store.enqueue("sess1", { messageId: "m1", text: "hi", mode: "queue" });
    await store.enqueue("sess2", { messageId: "m1", text: "hi", mode: "queue" });
    const ids = await store.listLogicalSessionIds();
    expect(ids.sort()).toEqual(["sess1", "sess2"]);
  });
});
test("unreadable as empty never happens — missing file returns undefined, not empty record", async () => {
  await withQueue(async (store) => {
    const rec = await store.load("nonexistent");
    expect(rec).toBeUndefined();
    expect(await store.hasPending("nonexistent")).toBe(false);
  });
});
test("v2 persists per-head MCP identity", async () => {
  await withQueue(async (store, dir) => {
    await store.enqueue("sess", { messageId: "m1", text: "hi", mode: "queue", mcpCoordinatorSession: "coord-X", mcpSourceHandle: "h1" });
    const rec = await store.load("sess");
    expect(rec?.schema).toBe("xacpx.runtime-queue.v2");
    expect(rec?.items[0].mcpCoordinatorSession).toBe("coord-X");
    expect(rec?.items[0].mcpSourceHandle).toBe("h1");
    expect(rec?.items[0].mcpIdentityKnown).toBe(true);
    // also verify durable file contains v2
    const raw = await readFile(join(dir, `${encodeURIComponent("sess")}.json`), "utf8");
    const parsed = JSON.parse(raw) as { schema: string };
    expect(parsed.schema).toBe("xacpx.runtime-queue.v2");
  });
});
test("legacy v1 journal is readable and new enqueue bumps to v2", async () => {
  await withQueue(async (store, dir) => {
    // Manually write a legacy v1 journal without per-head MCP fields
    const v1 = { schema: "xacpx.runtime-queue.v1", logicalSessionId: "sess", items: [{ messageId: "m1", text: "legacy", acceptedAt: new Date().toISOString(), mode: "queue" as const }] };
    await writeFile(join(dir, `${encodeURIComponent("sess")}.json`), JSON.stringify(v1, null, 2), "utf8");
    const loaded = await store.load("sess");
    expect(loaded?.schema).toBe("xacpx.runtime-queue.v1");
    expect(loaded?.items[0].mcpCoordinatorSession).toBeUndefined();
    expect(loaded?.items[0].mcpIdentityKnown).toBeUndefined();
    // New enqueue should preserve legacy item and bump file to v2
    await store.enqueue("sess", { messageId: "m2", text: "new", mode: "queue", mcpCoordinatorSession: "coord-Y" });
    const after = await store.load("sess");
    expect(after?.schema).toBe("xacpx.runtime-queue.v2");
    expect(after?.items.length).toBe(2);
    expect(after?.items[0].text).toBe("legacy");
    expect(after?.items[0].mcpIdentityKnown).toBeUndefined();
    expect(after?.items[1].mcpCoordinatorSession).toBe("coord-Y");
    expect(after?.items[1].mcpIdentityKnown).toBe(true);
  });
});
