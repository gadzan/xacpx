import { test, expect, mock } from "bun:test";

const deleteFiles = mock(async () => {});
// Stub the sibling helper so we can assert deleteSession invokes the real file
// delete with the resolved acpxRecordId, without touching the real ~/.acpx dir.
// bridge-runtime imports "../transport/acpx-session-files"; mock.module matches
// by resolved module path, so stub the source module the runtime references.
mock.module("../../../src/transport/acpx-session-files", () => ({
  deleteAcpxSessionFiles: deleteFiles,
}));

import { BridgeRuntime } from "../../../src/bridge/bridge-runtime";

const input = { agent: "codex", cwd: "/repo", name: "demo" };
const recordId = "019d009c-1111-7000-8000-aaaaaaaaaaaa";

test("deleteSession closes then deletes files by acpxRecordId", async () => {
  deleteFiles.mockClear();
  const calls: string[][] = [];
  // readSessionRecord (`sessions show`) returns the record JSON; removeSession
  // (`sessions close`) returns a clean exit. Both flow through `this.run`.
  const run = mock(async (_command: string, args: string[]) => {
    calls.push(args);
    if (args.includes("show")) {
      return { code: 0, stdout: JSON.stringify({ acpxRecordId: recordId }), stderr: "" };
    }
    return { code: 0, stdout: "", stderr: "" };
  });
  const runtime = new BridgeRuntime("acpx", run);

  await runtime.deleteSession(input);

  // sessions show (record read) then sessions close (removeSession) both ran.
  expect(calls.some((args) => args.includes("show"))).toBe(true);
  expect(calls.some((args) => args.includes("close"))).toBe(true);
  // Then delete the on-disk record files for the resolved record id.
  expect(deleteFiles).toHaveBeenCalledTimes(1);
  expect(deleteFiles).toHaveBeenCalledWith({ acpxRecordId: recordId });
});

test("deleteSession is a no-op when the record can't be resolved", async () => {
  deleteFiles.mockClear();
  const calls: string[][] = [];
  // `sessions show` fails → readSessionRecord throws → no-op branch.
  const run = mock(async (_command: string, args: string[]) => {
    calls.push(args);
    return { code: 1, stdout: "", stderr: "no named session" };
  });
  const runtime = new BridgeRuntime("acpx", run);

  await expect(runtime.deleteSession(input)).resolves.toEqual({});
  // No close was issued and no files were deleted.
  expect(calls.some((args) => args.includes("close"))).toBe(false);
  expect(deleteFiles).not.toHaveBeenCalled();
});

test("deleteSession treats a malformed record id as unresolvable (no delete)", async () => {
  deleteFiles.mockClear();
  // acpx returns valid JSON but an empty/short id → must hit the no-op branch
  // rather than deleting files for a bad id.
  const run = mock(async (_command: string, args: string[]) => {
    if (args.includes("show")) {
      return { code: 0, stdout: JSON.stringify({ acpxRecordId: "" }), stderr: "" };
    }
    return { code: 0, stdout: "", stderr: "" };
  });
  const runtime = new BridgeRuntime("acpx", run);

  await expect(runtime.deleteSession(input)).resolves.toEqual({});
  expect(deleteFiles).not.toHaveBeenCalled();
});
