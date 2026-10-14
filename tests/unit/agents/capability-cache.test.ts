import { expect, test } from "bun:test";

import { createStateCapabilityCache } from "../../../src/agents/capability-cache";
import { createEmptyState } from "../../../src/state/types";
import { parseState } from "../../../src/state/state-store";

const NOW = "2026-10-09T00:00:00.000Z";

function makeCache(write: (next: unknown) => Promise<void> = async () => {}) {
  const state = createEmptyState();
  const writes: unknown[] = [];
  const cache = createStateCapabilityCache(
    state,
    (critical) => critical(),
    async (next) => {
      writes.push(next);
      await write(next);
    },
  );
  return { cache, state, writes };
}

test("a written list is read back under the same fingerprint", async () => {
  const { cache } = makeCache();
  cache.persist("fp-1", { models: [{ modelId: "gpt-a", name: "GPT A" }], efforts: ["high"], effortKnown: true, fetchedAt: NOW });
  await cache.settled();
  expect(cache.load("fp-1")).toEqual({
    models: [{ modelId: "gpt-a", name: "GPT A" }],
    efforts: ["high"],
    effortKnown: true,
    fetchedAt: NOW,
  });
  expect(cache.load("missing")).toBeUndefined();
});

test("the state section round-trips through state.json parsing", async () => {
  const { cache, writes } = makeCache();
  cache.persist("fp-2", { models: [{ modelId: "gpt-b" }], efforts: [], effortKnown: false, fetchedAt: NOW });
  await cache.settled();

  // Parse the committed snapshot back the way a daemon restart would.
  const reloaded = parseState(writes[0], "state.json");
  expect(reloaded.capability_lists["fp-2"]).toEqual({
    models: [{ model_id: "gpt-b" }],
    efforts: [],
    effort_known: false,
    fetched_at: NOW,
  });
  // A fresh cache over the reloaded state serves the list without a probe.
  const restarted = createStateCapabilityCache(reloaded, (critical) => critical(), async () => {});
  expect(restarted.load("fp-2")?.models[0]?.modelId).toBe("gpt-b");
});

test("a malformed or empty capability section never blocks the state load", () => {
  expect(parseState({ capability_lists: "nope" }, "state.json").capability_lists).toEqual({});
  expect(parseState({ capability_lists: { fp: { models: [] } } }, "state.json").capability_lists).toEqual({});
  expect(parseState({ capability_lists: { fp: { models: [{ model_id: 5 }] } } }, "state.json").capability_lists).toEqual({});
  // A record missing fetched_at is dropped, not half-loaded.
  const parsed = parseState({
    capability_lists: { fp: { models: [{ model_id: "gpt-c" }], efforts: [], effort_known: true } },
  }, "state.json");
  expect(parsed.capability_lists).toEqual({});
});

test("the committed snapshot carries the list and keeps live state intact", async () => {
  const { cache, state, writes } = makeCache();
  cache.persist("fp-keep", { models: [{ modelId: "gpt-keep" }], efforts: [], effortKnown: false, fetchedAt: NOW });
  await cache.settled();

  // capability_lists is live-only, so the durable snapshot must carry the
  // entry while the live object keeps its identity.
  expect(writes).toHaveLength(1);
  const written = writes[0] as { capability_lists: Record<string, { models: Array<{ model_id: string }> }> };
  expect(written.capability_lists["fp-keep"]?.models[0]?.model_id).toBe("gpt-keep");
  expect(cache.load("fp-keep")?.models[0]?.modelId).toBe("gpt-keep");
});

test("a second write does not clobber the first entry", async () => {
  const { cache, writes } = makeCache();
  cache.persist("fp-1", { models: [{ modelId: "gpt-1" }], efforts: [], effortKnown: false, fetchedAt: NOW });
  cache.persist("fp-2", { models: [{ modelId: "gpt-2" }], efforts: [], effortKnown: false, fetchedAt: NOW });
  await cache.settled();

  const last = writes.at(-1) as { capability_lists: Record<string, unknown> };
  expect(Object.keys(last.capability_lists).sort()).toEqual(["fp-1", "fp-2"]);
});

test("a failed write leaves the in-memory list usable and the live state untouched", async () => {
  const { cache, state } = makeCache(async () => {
    throw new Error("disk full");
  });
  cache.persist("fp-fail", { models: [{ modelId: "gpt-fail" }], efforts: [], effortKnown: false, fetchedAt: NOW });
  await cache.settled();
  // Reads still work from memory, and a failed write did not corrupt state.
  expect(cache.load("fp-fail")?.models[0]?.modelId).toBe("gpt-fail");
  expect(state.capability_lists).toEqual({});
});
