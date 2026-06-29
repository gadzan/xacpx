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

test("DebouncedStateStore calls onError when save fails", async () => {
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

  await expect(store.save({ sessions: {}, chat_contexts: {} })).rejects.toThrow("save failed");
  await new Promise((r) => setTimeout(r, 50));

  expect(errors.length).toBe(1);
  await store.dispose();
});

test("DebouncedStateStore schedules another flush after current flush completes", async () => {
  let saveCount = 0;
  let inSave = false;
  const store = new DebouncedStateStore({
    delegate: {
      save: async () => {
        inSave = true;
        saveCount++;
        await new Promise((r) => setTimeout(r, 20));
        inSave = false;
      },
    },
    intervalMs: 10,
  });

  await store.save({ sessions: { a: 1 }, chat_contexts: {} });
  await new Promise((r) => setTimeout(r, 5));
  await store.save({ sessions: { b: 2 }, chat_contexts: {} });
  await new Promise((r) => setTimeout(r, 50));

  expect(saveCount).toBe(2);
  await store.dispose();
});