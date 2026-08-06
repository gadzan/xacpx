import { expect, test } from "bun:test";

import { main } from "../../src/main";

test("app bootstrap exports a runnable entry module", () => {
  expect(typeof main).toBe("function");
});

test("the direct source entry delegates to the guarded default runtime", async () => {
  let calls = 0;
  await main({
    runRuntime: async () => { calls += 1; },
  });
  expect(calls).toBe(1);
});
