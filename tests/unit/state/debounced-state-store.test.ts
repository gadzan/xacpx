import { expect, test } from "bun:test";
import { DebouncedStateStore } from "../../../src/state/debounced-state-store";

test("DebouncedStateStore saves state after debounce interval", async () => {
  const savedStates: any[] = [];
  const store = new DebouncedStateStore({
    delegate: {
      save: async (state) => {
        savedStates.push(state);
      },
    },
    intervalMs: 10,
  });

  await store.save({ sessions: {}, chat_contexts: {} });
  await new Promise((r) => setTimeout(r, 50));

  expect(savedStates.length).toBe(1);
  await store.dispose();
});

test("DebouncedStateStore batches multiple saves within interval", async () => {
  const savedStates: any[] = [];
  const store = new DebouncedStateStore({
    delegate: {
      save: async (state) => {
        savedStates.push(state);
      },
    },
    intervalMs: 10,
  });

  await Promise.all([
    store.save({ sessions: { a: 1 }, chat_contexts: {} }),
    store.save({ sessions: { b: 2 }, chat_contexts: {} }),
    store.save({ sessions: { c: 3 }, chat_contexts: {} }),
  ]);
  await new Promise((r) => setTimeout(r, 50));

  expect(savedStates.length).toBe(1);
  expect(savedStates[0].sessions).toEqual({ c: 3 });
  await store.dispose();
});

test("DebouncedStateStore flushes pending saves immediately", async () => {
  const savedStates: any[] = [];
  const store = new DebouncedStateStore({
    delegate: {
      save: async (state) => {
        savedStates.push(state);
      },
    },
    intervalMs: 1000,
  });

  await store.save({ sessions: { test: 1 }, chat_contexts: {} });
  await store.flush();

  expect(savedStates.length).toBe(1);
  await store.dispose();
});

test("DebouncedStateStore save resolves before the debounced write reaches the delegate", async () => {
  let writes = 0;
  const store = new DebouncedStateStore({
    delegate: {
      save: async () => {
        writes += 1;
      },
    },
    // Long interval on purpose: a save() that waited for the flush would stall
    // here and the write counter would already be 1 by the time we assert.
    intervalMs: 1000,
  });

  await store.save({ sessions: {}, chat_contexts: {} });

  expect(writes).toBe(0);
  await store.flush();
  expect(writes).toBe(1);
  await store.dispose();
});

test("DebouncedStateStore coalesces sequential awaited saves within one interval", async () => {
  // Mirrors the production pattern: services persist under a shared mutex, so
  // every save is awaited before the next mutation starts. Under the old
  // contract (save resolves only after the flush) each save paid the full
  // debounce interval and NOTHING ever coalesced — N writes, N x interval.
  const savedStates: any[] = [];
  const store = new DebouncedStateStore({
    delegate: {
      save: async (state) => {
        savedStates.push(state);
      },
    },
    intervalMs: 50,
  });

  await store.save({ sessions: { a: 1 }, chat_contexts: {} });
  await store.save({ sessions: { b: 2 }, chat_contexts: {} });
  await store.save({ sessions: { c: 3 }, chat_contexts: {} });
  await store.flush();

  expect(savedStates.length).toBe(1);
  expect(savedStates[0].sessions).toEqual({ c: 3 });
  await store.dispose();
});

test("DebouncedStateStore saveNow writes immediately and supersedes a pending debounced snapshot", async () => {
  const savedStates: any[] = [];
  const store = new DebouncedStateStore({
    delegate: {
      save: async (state) => {
        savedStates.push(state);
      },
    },
    intervalMs: 1000,
  });

  await store.save({ sessions: { debounced: 1 }, chat_contexts: {} });
  // saveNow must not wait for the 1000ms debounce window, and its (strictly
  // newer, mutex-ordered) snapshot supersedes the pending debounced one.
  await store.saveNow({ sessions: { durable: 2 }, chat_contexts: {} });

  expect(savedStates.length).toBe(1);
  expect(savedStates[0].sessions).toEqual({ durable: 2 });
  await store.flush();
  expect(savedStates.length).toBe(1);
  await store.dispose();
});

test("DebouncedStateStore saveNow rejects on write failure (durability-gated callers must see it)", async () => {
  const errors: unknown[] = [];
  const store = new DebouncedStateStore({
    delegate: {
      save: async () => {
        throw new Error("disk full");
      },
    },
    intervalMs: 10,
    onError: (error) => {
      errors.push(error);
    },
  });

  await expect(store.saveNow({ sessions: {}, chat_contexts: {} })).rejects.toThrow("disk full");
  expect(errors.length).toBe(1);
  await store.dispose();
});

test("DebouncedStateStore saveNow waits out an in-flight debounced write before writing", async () => {
  const order: string[] = [];
  const store = new DebouncedStateStore({
    delegate: {
      save: async (state: any) => {
        order.push(`start:${Object.keys(state.sessions)[0]}`);
        await new Promise((r) => setTimeout(r, 20));
        order.push(`end:${Object.keys(state.sessions)[0]}`);
      },
    },
    intervalMs: 5,
  });

  await store.save({ sessions: { a: 1 }, chat_contexts: {} });
  await new Promise((r) => setTimeout(r, 10)); // first write now in flight
  await store.saveNow({ sessions: { b: 2 }, chat_contexts: {} });

  expect(order).toEqual(["start:a", "end:a", "start:b", "end:b"]);
  await store.dispose();
});

test("DebouncedStateStore rejects save after dispose", async () => {
  const store = new DebouncedStateStore({
    delegate: { save: async () => {} },
    intervalMs: 10,
  });

  await store.dispose();

  await expect(store.save({ sessions: {}, chat_contexts: {} })).rejects.toThrow("DebouncedStateStore is disposed");
});

test("DebouncedStateStore handles concurrent saves with flush", async () => {
  const savedStates: any[] = [];
  const store = new DebouncedStateStore({
    delegate: {
      save: async (state) => {
        savedStates.push(state);
        await new Promise((r) => setTimeout(r, 5));
      },
    },
    intervalMs: 10,
  });

  store.save({ sessions: { a: 1 }, chat_contexts: {} });
  store.save({ sessions: { b: 2 }, chat_contexts: {} });
  await store.flush();

  expect(savedStates.length).toBe(1);
  await store.dispose();
});

test("DebouncedStateStore reports write failures via onError, not via the save promise", async () => {
  // save() resolves at commit time (before the flush), so a later disk failure
  // can only surface through onError — the logging path main.ts wires up.
  const errors: unknown[] = [];
  const store = new DebouncedStateStore({
    delegate: {
      save: async () => {
        throw new Error("save failed");
      },
    },
    intervalMs: 10,
    onError: (error) => {
      errors.push(error);
    },
  });

  await store.save({ sessions: {}, chat_contexts: {} });
  await store.flush();

  expect(errors.length).toBe(1);
  expect(errors[0]).toBeInstanceOf(Error);
  await store.dispose();
});

test("DebouncedStateStore schedules another flush after current flush completes", async () => {
  let saveCount = 0;
  const store = new DebouncedStateStore({
    delegate: {
      save: async () => {
        saveCount++;
        await new Promise((r) => setTimeout(r, 20));
      },
    },
    intervalMs: 10,
  });

  await store.save({ sessions: { a: 1 }, chat_contexts: {} });
  // Let the debounce timer fire so the first write is in flight...
  await new Promise((r) => setTimeout(r, 15));
  // ...then commit a new snapshot during that write; it must get its own flush.
  await store.save({ sessions: { b: 2 }, chat_contexts: {} });
  await new Promise((r) => setTimeout(r, 60));

  expect(saveCount).toBe(2);
  await store.dispose();
});