import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { __privateFileForTests, writePrivateFileSync } from "../../../src/util/private-file";

function transientError(code: string): NodeJS.ErrnoException {
  const err = new Error("locked") as NodeJS.ErrnoException;
  err.code = code;
  return err;
}

test("writePrivateFileSync falls back to a direct write on a transient windows error", () => {
  const dir = mkdtempSync(join(tmpdir(), "weacpx-private-file-"));
  const target = join(dir, "nested", "secret.json");
  let directCalls = 0;

  writePrivateFileSync(target, "payload", {
    platform: "win32",
    atomicWrite: () => {
      throw transientError("EPERM");
    },
    directWrite: (p, c) => {
      directCalls += 1;
      writeFileSync(p, c);
    },
  });

  expect(directCalls).toBe(1);
  expect(readFileSync(target, "utf8")).toBe("payload");
  rmSync(dir, { recursive: true, force: true });
});

test("writePrivateFileSync rethrows a non-transient error without falling back", () => {
  const dir = mkdtempSync(join(tmpdir(), "weacpx-private-file-"));
  let directCalls = 0;

  expect(() =>
    writePrivateFileSync(join(dir, "secret.json"), "payload", {
      platform: "linux",
      atomicWrite: () => {
        throw transientError("EPERM"); // transient code, but non-win32 → not transient
      },
      directWrite: () => {
        directCalls += 1;
      },
    }),
  ).toThrow("locked");

  expect(directCalls).toBe(0);
  rmSync(dir, { recursive: true, force: true });
});

test("windows atomic write retries transient EPERM long enough before failing", async () => {
  let attempts = 0;
  const delays: number[] = [];

  let caught: unknown = undefined;
  try {
    await __privateFileForTests.retryTransientFileErrors(
      async () => {
        attempts += 1;
        const err = new Error("locked") as NodeJS.ErrnoException;
        err.code = "EPERM";
        throw err;
      },
      {
        platform: "win32",
        delay: async (ms) => {
          delays.push(ms);
        },
      },
    );
  } catch (error) {
    caught = error;
  }

  expect(caught).toBeInstanceOf(Error);
  expect(attempts).toBeGreaterThanOrEqual(20);
  expect(Math.max(...delays)).toBeLessThanOrEqual(500);
});

test("windows atomic write retries transient EPERM until success", async () => {
  let attempts = 0;

  await __privateFileForTests.retryTransientFileErrors(
    async () => {
      attempts += 1;
      if (attempts < 10) {
        const err = new Error("locked") as NodeJS.ErrnoException;
        err.code = "EPERM";
        throw err;
      }
    },
    {
      platform: "win32",
      delay: async () => {},
    },
  );

  expect(attempts).toBe(10);
});

test("non-windows platforms do not retry", async () => {
  let attempts = 0;

  let caught: unknown = undefined;
  try {
    await __privateFileForTests.retryTransientFileErrors(
      async () => {
        attempts += 1;
        const err = new Error("locked") as NodeJS.ErrnoException;
        err.code = "EBUSY";
        throw err;
      },
      {
        platform: "linux",
        delay: async () => {},
      },
    );
  } catch (error) {
    caught = error;
  }

  expect(caught).toBeInstanceOf(Error);
  expect(attempts).toBe(1);
});
