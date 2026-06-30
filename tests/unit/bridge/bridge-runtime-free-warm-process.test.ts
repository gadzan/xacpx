import { test, expect, mock } from "bun:test";

const terminate = mock(async (_sessionId: string) => {});
// Stub the launcher helper; bridge-runtime imports it from
// "../transport/acpx-queue-owner-launcher". Re-export AcpxQueueOwnerLauncher so
// the runtime's other import from that module still resolves.
mock.module("../../../src/transport/acpx-queue-owner-launcher", () => ({
  AcpxQueueOwnerLauncher: class {},
  terminateAcpxQueueOwner: terminate,
}));

import { BridgeRuntime } from "../../../src/bridge/bridge-runtime";

const input = { agent: "codex", cwd: "/repo", name: "demo" };
const recordId = "019d009c-1111-7000-8000-aaaaaaaaaaaa";

test("freeWarmProcess terminates the warm owner by acpxRecordId", async () => {
  terminate.mockClear();
  const calls: string[][] = [];
  const run = mock(async (_command: string, args: string[]) => {
    calls.push(args);
    if (args.includes("show")) {
      return { code: 0, stdout: JSON.stringify({ acpxRecordId: recordId }), stderr: "" };
    }
    return { code: 0, stdout: "", stderr: "" };
  });
  const runtime = new BridgeRuntime("acpx", run);

  await expect(runtime.freeWarmProcess(input)).resolves.toEqual({});

  expect(calls.some((args) => args.includes("show"))).toBe(true);
  // Must NOT close: no `sessions close` is issued.
  expect(calls.some((args) => args.includes("close"))).toBe(false);
  expect(terminate).toHaveBeenCalledTimes(1);
  expect(terminate).toHaveBeenCalledWith(recordId);
});

test("freeWarmProcess is a no-op when the record can't be resolved", async () => {
  terminate.mockClear();
  const run = mock(async (_command: string, _args: string[]) => ({
    code: 1, stdout: "", stderr: "no named session",
  }));
  const runtime = new BridgeRuntime("acpx", run);

  await expect(runtime.freeWarmProcess(input)).resolves.toEqual({});
  expect(terminate).not.toHaveBeenCalled();
});
