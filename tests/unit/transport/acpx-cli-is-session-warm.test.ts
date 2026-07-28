import { test, expect, spyOn, mock } from "bun:test";

// Stub the lock-file pid reader and the pid liveness probe so isSessionWarm is
// tested without touching ~/.acpx/queues or real processes. Re-export the other
// names the transport pulls from each module so the real ones still resolve.
const readPid = mock(async (_sessionId: string): Promise<number | undefined> => undefined);
mock.module("../../../src/transport/acpx-queue-owner-launcher", () => ({
  AcpxQueueOwnerLauncher: class {},
  terminateAcpxQueueOwner: async () => {},
  readQueueOwnerPid: readPid,
}));
const alive = mock((_pid: number) => false);
mock.module("../../../src/daemon/daemon-files", () => ({
  isProcessAlive: alive,
}));

import { AcpxCliTransport } from "../../../src/transport/acpx-cli/acpx-cli-transport";
import type { ResolvedSession } from "../../../src/transport/types";

const session: ResolvedSession = {
  alias: "api-fix",
  agent: "codex",
  agentCommand: "./node_modules/.bin/codex-acp",
  workspace: "backend",
  transportSession: "backend:api-fix",
  cwd: "/tmp/backend",
};

function makeTransport() {
  const run = mock(async () => ({ code: 0, stdout: "", stderr: "" }));
  const runPty = mock(async () => ({ code: 0, stdout: "", stderr: "" }));
  return new AcpxCliTransport({ command: "acpx" }, run, runPty);
}

test("isSessionWarm is true when the lock pid is alive, false once it dies", async () => {
  readPid.mockClear();
  const transport = makeTransport();
  spyOn(transport as never, "readSessionRecord").mockResolvedValue({ acpxRecordId: "ws:rec-1" } as never);
  readPid.mockResolvedValue(4242);

  alive.mockReturnValue(true);
  await expect(transport.isSessionWarm(session)).resolves.toBe(true);
  expect(readPid).toHaveBeenCalledWith("ws:rec-1");

  alive.mockReturnValue(false);
  await expect(transport.isSessionWarm(session)).resolves.toBe(false);
});

test("isSessionWarm caches the record id across polls", async () => {
  readPid.mockClear();
  readPid.mockResolvedValue(undefined);
  const transport = makeTransport();
  const readRecord = spyOn(transport as never, "readSessionRecord").mockResolvedValue({
    acpxRecordId: "ws:rec-2",
  } as never);

  await transport.isSessionWarm(session);
  await transport.isSessionWarm(session);

  // `acpx sessions show` (readSessionRecord) is spawned once, not per tick.
  expect(readRecord).toHaveBeenCalledTimes(1);
  expect(readPid).toHaveBeenCalledTimes(2);
});

test("session lifecycle ops drop the cached record id so warmth re-resolves", async () => {
  readPid.mockClear();
  readPid.mockResolvedValue(undefined);
  const transport = makeTransport();
  const readRecord = spyOn(transport as never, "readSessionRecord")
    .mockResolvedValueOnce({ acpxRecordId: "ws:rec-A" } as never)
    .mockResolvedValueOnce({ acpxRecordId: "ws:rec-B" } as never);

  await transport.isSessionWarm(session);
  expect(readPid).toHaveBeenLastCalledWith("ws:rec-A");

  // Recreating a record under the same transport-session name (e.g. native
  // re-attach after delete) must invalidate the cache, or warmth polls keep
  // reading the dead record's lock forever.
  await transport.resumeAgentSession(session, "ses_abc");

  await transport.isSessionWarm(session);
  expect(readRecord).toHaveBeenCalledTimes(2);
  expect(readPid).toHaveBeenLastCalledWith("ws:rec-B");
});

test("isSessionWarm is false when the session record can't be resolved", async () => {
  readPid.mockClear();
  const transport = makeTransport();
  spyOn(transport as never, "readSessionRecord").mockRejectedValue(new Error("no session") as never);

  await expect(transport.isSessionWarm(session)).resolves.toBe(false);
  expect(readPid).not.toHaveBeenCalled();
});

test("isSessionWarm is false when the lock file is missing", async () => {
  const transport = makeTransport();
  spyOn(transport as never, "readSessionRecord").mockResolvedValue({ acpxRecordId: "ws:rec-3" } as never);
  readPid.mockResolvedValue(undefined);
  alive.mockClear();

  await expect(transport.isSessionWarm(session)).resolves.toBe(false);
  expect(alive).not.toHaveBeenCalled();
});
