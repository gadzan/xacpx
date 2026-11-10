import { expect, test } from "bun:test";

import {
  emptyCapability,
  parseAgentCapabilityState,
  readyCapability,
} from "../../../packages/relay-protocol/src/agent-capability";

const FETCHED_AT = "2026-11-10T00:00:00.000Z";

function roundTrip(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}

test("empty state round-trips through stringify/parse", () => {
  const state = emptyCapability(
    { code: "discovery-available", message: "Agent answered with no models." },
    "Add a model in the agent, then refresh.",
    { fetchedAt: FETCHED_AT, suggestions: ["custom-model"] },
  );
  expect(parseAgentCapabilityState(roundTrip(state))).toEqual(state);
});

test("ready freshness fields round-trip through stringify/parse", () => {
  const state = readyCapability("cache", [{ modelId: "gpt-a" }], {
    fetchedAt: FETCHED_AT,
    freshness: "stale",
    refreshing: true,
    lastVerifiedAt: FETCHED_AT,
  });
  const parsed = parseAgentCapabilityState(roundTrip(state));
  expect(parsed).toEqual(state);
  if (parsed.status === "ready") {
    expect(parsed.freshness).toBe("stale");
    expect(parsed.refreshing).toBe(true);
    expect(parsed.lastVerifiedAt).toBe(FETCHED_AT);
  } else {
    throw new Error(`expected ready, got ${parsed.status}`);
  }
});

test("old-core ready payload without new fields parses unchanged", () => {
  const payload = {
    status: "ready",
    models: [{ modelId: "gpt-a", name: "GPT A", source: "adapter" }],
    suggestions: [],
    efforts: { status: "unavailable" },
    fetchedAt: FETCHED_AT,
    source: "probe",
    effect: { kind: "default" },
  };
  expect(parseAgentCapabilityState(roundTrip(payload))).toEqual(
    readyCapability("probe", [{ modelId: "gpt-a", name: "GPT A" }], { fetchedAt: FETCHED_AT }),
  );
});

test("unknown status stays fail-closed, never an empty list", () => {
  const parsed = parseAgentCapabilityState({ status: "empty-list", models: [] });
  expect(parsed.status).toBe("error");
  if (parsed.status === "error") expect(parsed.reason.code).toBe("stale-response");
});

test("incomplete ready stays fail-closed", () => {
  const parsed = parseAgentCapabilityState({
    status: "ready",
    models: [],
    fetchedAt: FETCHED_AT,
    source: "probe",
  });
  expect(parsed.status).toBe("error");
  if (parsed.status === "error") expect(parsed.reason.code).toBe("stale-response");
});

test("incomplete empty stays fail-closed, never an empty list", () => {
  const parsed = parseAgentCapabilityState({ status: "empty", fetchedAt: FETCHED_AT });
  expect(parsed.status).toBe("error");
  if (parsed.status === "error") expect(parsed.reason.code).toBe("stale-response");
});
