import { expect, test } from "bun:test";
import { settleWithinTimeout } from "../../../src/util/async";

test("settleWithinTimeout resolves when work completes before timeout", async () => {
  let resolved = false;
  const promise = settleWithinTimeout(
    new Promise<void>((resolve) => {
      setTimeout(() => {
        resolved = true;
        resolve();
      }, 10);
    }),
    1000,
  );

  await promise;
  expect(resolved).toBe(true);
});

test("settleWithinTimeout resolves when work rejects before timeout", async () => {
  let rejected = false;
  const promise = settleWithinTimeout(
    new Promise<void>((_, reject) => {
      setTimeout(() => {
        rejected = true;
        reject(new Error("test error"));
      }, 10);
    }),
    1000,
  );

  await promise;
  expect(rejected).toBe(true);
});

test("settleWithinTimeout resolves after timeout when work is still pending", async () => {
  let completed = false;
  const promise = settleWithinTimeout(
    new Promise<void>((resolve) => {
      setTimeout(() => {
        completed = true;
        resolve();
      }, 1000);
    }),
    10,
  );

  await promise;
  expect(completed).toBe(false);
});

test("settleWithinTimeout handles immediate resolution", async () => {
  await settleWithinTimeout(Promise.resolve(), 1000);
});

test("settleWithinTimeout handles immediate rejection", async () => {
  await settleWithinTimeout(Promise.reject(new Error("immediate")), 1000);
});