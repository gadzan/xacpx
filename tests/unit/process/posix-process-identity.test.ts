import { expect, test } from "bun:test";

import { probePosixProcessIdentity } from "../../../src/process/posix-process-identity";

test("parses the locale-stable ps process start time", async () => {
  await expect(probePosixProcessIdentity(42, {
    runPs: async () => "Thu Aug  6 20:00:00 2026\n",
  })).resolves.toEqual({
    status: "found",
    identity: {
      pid: 42,
      startedAtMs: Date.parse("Thu Aug  6 20:00:00 2026"),
    },
  });
});

test("distinguishes a missing process from an unavailable identity probe", async () => {
  await expect(probePosixProcessIdentity(42, {
    runPs: async () => null,
  })).resolves.toEqual({ status: "missing" });

  await expect(probePosixProcessIdentity(42, {
    runPs: async () => "not-a-date\n",
  })).resolves.toEqual({ status: "unavailable" });

  await expect(probePosixProcessIdentity(42, {
    runPs: async () => { throw new Error("ps unavailable"); },
  })).resolves.toEqual({ status: "unavailable" });
});
