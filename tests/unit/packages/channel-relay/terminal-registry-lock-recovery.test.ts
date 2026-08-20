import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  TerminalRegistryStore,
  terminalRegistryWriterLockRetries,
  type TerminalRegistryLockRetries,
} from "../../../../packages/channel-relay/src/terminal/terminal-registry-store";

test("Windows writer-lock retry policy spans the 30s stale lease without changing POSIX fail-fast", () => {
  expect(terminalRegistryWriterLockRetries("linux")).toBe(0);
  expect(terminalRegistryWriterLockRetries("darwin")).toBe(0);
  expect(terminalRegistryWriterLockRetries("win32")).toEqual({
    retries: 35,
    factor: 1,
    minTimeout: 1_000,
    maxTimeout: 1_000,
    randomize: false,
  });
});

test("exclusive writer forwards the configured retry policy to proper-lockfile", async () => {
  const dir = mkdtempSync(join(tmpdir(), "term-registry-retry-"));
  const retryPolicy: TerminalRegistryLockRetries = {
    retries: 3,
    factor: 1,
    minTimeout: 25,
    maxTimeout: 25,
    randomize: false,
  };
  let observed: TerminalRegistryLockRetries | undefined;
  const store = new TerminalRegistryStore({
    dir,
    exclusiveWriter: true,
    writerLockRetries: retryPolicy,
    deps: {
      lock: async (_resource, options) => {
        observed = options.retries;
        return async () => {};
      },
    },
  });
  try {
    await store.load();
    expect(observed).toEqual(retryPolicy);
  } finally {
    await store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
