import { test, expect, spyOn, mock } from "bun:test";

const terminate = mock(async (_sessionId: string) => {});
// Stub the launcher helper so we assert freeWarmProcess kills the warm owner by
// the resolved acpxRecordId, without touching the real ~/.acpx/queues dir.
// AcpxCliTransport imports it from "../acpx-queue-owner-launcher"; mock.module
// matches by resolved source path. Re-export the other named imports the
// transport pulls from that module so the real ones still resolve.
mock.module("../../../src/transport/acpx-queue-owner-launcher", () => ({
  AcpxQueueOwnerLauncher: class {},
  terminateAcpxQueueOwner: terminate,
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

test("freeWarmProcess terminates the warm owner by acpxRecordId", async () => {
  terminate.mockClear();
  const transport = makeTransport();
  const recordId = "ws:rec-456";
  const readRecord = spyOn(transport as never, "readSessionRecord").mockResolvedValue({
    acpxRecordId: recordId,
  } as never);

  await transport.freeWarmProcess?.(session);

  expect(readRecord).toHaveBeenCalledTimes(1);
  expect(terminate).toHaveBeenCalledTimes(1);
  expect(terminate).toHaveBeenCalledWith(recordId);
});

test("freeWarmProcess is a no-op when the session can't be resolved", async () => {
  terminate.mockClear();
  const transport = makeTransport();
  spyOn(transport as never, "readSessionRecord").mockRejectedValue(new Error("no session") as never);

  await expect(transport.freeWarmProcess?.(session)).resolves.toBeUndefined();
  expect(terminate).not.toHaveBeenCalled();
});
