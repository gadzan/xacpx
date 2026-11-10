import { expect, test } from "bun:test";

import {
  createStateCapabilityCache,
  isLegacyCapabilityKey,
} from "../../../src/agents/capability-cache";
import {
  MODEL_CATALOG_SOFT_TTL_MS,
  type CachedCapabilityV2,
} from "../../../src/agents/capability-discovery";
import { createEmptyState } from "../../../src/state/types";
import { parseState } from "../../../src/state/state-store";

const NOW = "2026-10-09T00:00:00.000Z";
const NOW_MS = Date.parse(NOW);

function v2entry(models: Array<{ modelId: string; name?: string }>, fetchedAt = NOW): CachedCapabilityV2 {
  return {
    schemaVersion: 2,
    models,
    efforts: [],
    effortKnown: false,
    fetchedAt,
    softExpiresAt: new Date(Date.parse(fetchedAt) + MODEL_CATALOG_SOFT_TTL_MS).toISOString(),
    source: "probe",
  };
}

function makeCache(
  write: (next: unknown) => Promise<void> = async () => {},
  nowMs: () => number = () => NOW_MS,
) {
  const state = createEmptyState();
  const writes: unknown[] = [];
  const cache = createStateCapabilityCache(
    state,
    (critical) => critical(),
    async (next) => {
      writes.push(next);
      await write(next);
    },
    nowMs,
  );
  return { cache, state, writes };
}

test("a written list is read back under the same fingerprint", async () => {
  const { cache } = makeCache();
  await cache.persist("v2:fp-1", v2entry([{ modelId: "gpt-a", name: "GPT A" }]));
  await cache.settled();
  expect(cache.load("v2:fp-1")).toEqual(v2entry([{ modelId: "gpt-a", name: "GPT A" }]));
  expect(cache.load("missing")).toBeUndefined();
});

test("the state section round-trips through state.json parsing", async () => {
  const { cache, writes } = makeCache();
  await cache.persist("v2:fp-2", v2entry([{ modelId: "gpt-b" }]));
  await cache.settled();

  // Parse the committed snapshot back the way a daemon restart would.
  const reloaded = parseState(writes[0], "state.json");
  expect(reloaded.capability_lists["v2:fp-2"]).toEqual({
    models: [{ model_id: "gpt-b" }],
    efforts: [],
    effort_known: false,
    fetched_at: NOW,
  });
  // A fresh cache over the reloaded state serves the list without a probe.
  // Provenance does not survive the restart, but the verification time does.
  const restarted = createStateCapabilityCache(reloaded, (critical) => critical(), async () => {}, () => NOW_MS);
  const entry = restarted.load("v2:fp-2");
  expect(entry?.models[0]?.modelId).toBe("gpt-b");
  expect(entry?.fetchedAt).toBe(NOW);
  expect(entry?.softExpiresAt).toBe(new Date(NOW_MS + MODEL_CATALOG_SOFT_TTL_MS).toISOString());
  expect(entry?.schemaVersion).toBe(2);
});

test("a V1 record under a legacy key is never served as fresh", async () => {
  const { cache, state } = makeCache();
  state.capability_lists["deadbeef"] = {
    models: [{ model_id: "gpt-v1" }],
    efforts: [],
    effort_known: false,
    fetched_at: NOW,
  };
  await cache.settled();
  expect(isLegacyCapabilityKey("deadbeef")).toBe(true);
  expect(isLegacyCapabilityKey("v2:deadbeef")).toBe(false);
  expect(cache.load("deadbeef")).toBeUndefined();
});
test("a persist prunes expired entries but keeps recent legacy records", async () => {
  const oldAt = new Date(NOW_MS - 31 * 24 * 60 * 60 * 1000).toISOString();
  const planted = createEmptyState();
  planted.capability_lists["v1old"] = {
    models: [{ model_id: "gpt-old" }],
    efforts: [],
    effort_known: false,
    fetched_at: oldAt,
  };
  planted.capability_lists["v1new"] = {
    models: [{ model_id: "gpt-new" }],
    efforts: [],
    effort_known: false,
    fetched_at: NOW,
  };
  const snapshots: unknown[] = [];
  const pruning = createStateCapabilityCache(
    planted,
    (critical) => critical(),
    async (next) => { snapshots.push(next); },
    () => NOW_MS,
  );
  await pruning.persist("v2:fp-1", v2entry([{ modelId: "gpt-fresh" }]));
  await pruning.settled();
  // Unchecked shape: the snapshot is our own in-process AppState clone.
  const snapshot: { capability_lists: Record<string, unknown> } = snapshots.at(-1) as { capability_lists: Record<string, unknown> };
  expect(snapshot.capability_lists["v1old"]).toBeUndefined();
  expect(snapshot.capability_lists["v1new"]).toBeDefined();
  expect(snapshot.capability_lists["v2:fp-1"]).toBeDefined();
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
  await cache.persist("v2:fp-keep", v2entry([{ modelId: "gpt-keep" }]));
  await cache.settled();

  // capability_lists is live-only, so the durable snapshot must carry the
  // entry while the live object keeps its identity.
  expect(writes).toHaveLength(1);
  // Unchecked shape: writes holds our own in-process AppState clones.
  const written = writes[0] as { capability_lists: Record<string, { models: Array<{ model_id: string }> }> };
  expect(written.capability_lists["v2:fp-keep"]?.models[0]?.model_id).toBe("gpt-keep");
  expect(cache.load("v2:fp-keep")?.models[0]?.modelId).toBe("gpt-keep");
  expect(state.capability_lists["v2:fp-keep"]).toBeUndefined();
});

test("a second write does not clobber the first entry", async () => {
  const { cache, writes } = makeCache();
  await cache.persist("v2:fp-1", v2entry([{ modelId: "gpt-1" }]));
  await cache.persist("v2:fp-2", v2entry([{ modelId: "gpt-2" }]));
  await cache.settled();

  // Unchecked shape: writes holds our own in-process AppState clones.
  const last = writes.at(-1) as { capability_lists: Record<string, unknown> };
  expect(Object.keys(last.capability_lists).sort()).toEqual(["v2:fp-1", "v2:fp-2"]);
});

test("a failed write rejects for observability while memory stays usable", async () => {
  const { cache, state } = makeCache(async () => {
    throw new Error("disk full");
  });
  await expect(cache.persist("v2:fp-fail", v2entry([{ modelId: "gpt-fail" }]))).rejects.toThrow("disk full");
  await cache.settled();
  // Reads still work from memory, and a failed write did not corrupt state.
  expect(cache.load("v2:fp-fail")?.models[0]?.modelId).toBe("gpt-fail");
  expect(state.capability_lists).toEqual({});
});
