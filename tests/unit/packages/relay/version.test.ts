import { expect, test } from "bun:test";
import { isNewer, readRelayVersion, createRelayUpdateChecker } from "../../../../packages/relay/src/version";

test("readRelayVersion reads the relay package.json version", () => {
  // Matches packages/relay/package.json — a semver string, not "unknown".
  expect(readRelayVersion()).toMatch(/^\d+\.\d+\.\d+/);
});

test("isNewer compares semver; a prerelease ranks below the same release", () => {
  expect(isNewer("0.7.0", "0.6.0")).toBe(true);
  expect(isNewer("0.6.0", "0.6.0")).toBe(false);
  expect(isNewer("0.6.0", "0.7.0")).toBe(false);
  expect(isNewer("0.7.0", "0.7.0-rc.1")).toBe(true);
});

test("isNewer returns false when either version is unparseable (e.g. 'unknown')", () => {
  // readRelayVersion falls back to "unknown" if it can't read package.json. Comparing
  // that as 0.0.0 would flag every published release as newer and falsely prompt.
  expect(isNewer("0.7.0", "unknown")).toBe(false);
  expect(isNewer("unknown", "0.6.0")).toBe(false);
  expect(isNewer("", "0.6.0")).toBe(false);
});

test("update checker does not flag an update when the current version is unknown", async () => {
  const check = createRelayUpdateChecker({
    current: "unknown",
    getLatest: async () => "0.7.0",
    now: () => 0,
    ttlMs: 1000,
  });
  expect(await check()).toEqual({ current: "unknown", latest: "0.7.0", updateAvailable: false });
});

test("update checker reports updateAvailable and caches the latest lookup", async () => {
  let calls = 0;
  let clock = 0;
  const check = createRelayUpdateChecker({
    current: "0.6.0",
    getLatest: async () => { calls += 1; return "0.7.0"; },
    now: () => clock,
    ttlMs: 1000,
  });
  expect(await check()).toEqual({ current: "0.6.0", latest: "0.7.0", updateAvailable: true });
  clock = 500; // within TTL → cached, no second call
  expect((await check()).latest).toBe("0.7.0");
  expect(calls).toBe(1);
  clock = 2000; // past TTL → refetch
  await check();
  expect(calls).toBe(2);
});

test("update checker tolerates a failing npm lookup (no poisoned cache)", async () => {
  let mode: "fail" | "ok" = "fail";
  const check = createRelayUpdateChecker({
    current: "0.6.0",
    getLatest: async () => (mode === "fail" ? null : "0.7.0"),
    now: () => 0,
    ttlMs: 1000,
  });
  expect(await check()).toEqual({ current: "0.6.0", latest: null, updateAvailable: false });
  mode = "ok"; // a null result must not have been cached → next call retries
  expect((await check()).latest).toBe("0.7.0");
});
