import { expect, test } from "bun:test";

import { StateCapabilityCache } from "../../../src/agents/capability-cache";
import { createEmptyState } from "../../../src/state/types";
import { parseState } from "../../../src/state/state-store";

const NOW = "2026-10-09T00:00:00.000Z";

function makeCache() {
  const state = createEmptyState();
  const writes: unknown[] = [];
  const cache = new StateCapabilityCache(state, async (next) => { writes.push(next); });
  return { cache, state, writes };
}

test("a written list is read back under the same fingerprint", async () => {
  const { cache } = makeCache();
  cache.persist("fp-1", { models: [{ modelId: "gpt-a", name: "GPT A" }], efforts: ["high"], effortKnown: true, fetchedAt: NOW });
  expect(cache.load("fp-1")).toEqual({
    models: [{ modelId: "gpt-a", name: "GPT A" }],
    efforts: ["high"],
    effortKnown: true,
    fetchedAt: NOW,
  });
  expect(cache.load("missing")).toBeUndefined();
});

test("the state section round-trips through state.json parsing", () => {
  const state = createEmptyState();
  const cache = new StateCapabilityCache(state, async () => {});
  cache.persist("fp-2", { models: [{ modelId: "gpt-b" }], efforts: [], effortKnown: false, fetchedAt: NOW });

  const reloaded = parseState({ capability_lists: state.capability_lists }, "state.json");
  expect(reloaded.capability_lists["fp-2"]).toEqual({
    models: [{ model_id: "gpt-b" }],
    efforts: [],
    effort_known: false,
    fetched_at: NOW,
  });
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
