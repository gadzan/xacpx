import { test, expect, spyOn, mock } from "bun:test";

const deleteFiles = mock(async () => {});
// Stub the sibling helper so we can assert deleteSession invokes the real file
// delete with the resolved acpxRecordId, without touching the real ~/.acpx dir.
// The impl imports "../acpx-session-files.js"; mock.module matches by resolved
// module path, so stub the source module both transports/tests reference.
mock.module("../../../src/transport/acpx-session-files", () => ({
  deleteAcpxSessionFiles: deleteFiles,
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

test("deleteSession closes then deletes files by acpxRecordId", async () => {
  deleteFiles.mockClear();
  const transport = makeTransport();
  const recordId = "ws:rec-123";

  const readRecord = spyOn(transport as never, "readSessionRecord").mockResolvedValue({
    acpxRecordId: recordId,
  } as never);
  const remove = spyOn(transport, "removeSession" as never).mockResolvedValue(undefined as never);

  await transport.deleteSession?.(session);

  expect(readRecord).toHaveBeenCalledTimes(1);
  // Close first (keeps a live process/queue owner from holding the files).
  expect(remove).toHaveBeenCalledTimes(1);
  expect(remove).toHaveBeenCalledWith(session);
  // Then delete the on-disk record files for the resolved record id.
  expect(deleteFiles).toHaveBeenCalledTimes(1);
  expect(deleteFiles).toHaveBeenCalledWith({ acpxRecordId: recordId });
});

test("deleteSession is a no-op when the session can't be resolved", async () => {
  deleteFiles.mockClear();
  const transport = makeTransport();

  spyOn(transport as never, "readSessionRecord").mockRejectedValue(new Error("no session") as never);
  const remove = spyOn(transport, "removeSession" as never).mockResolvedValue(undefined as never);

  await expect(transport.deleteSession?.(session)).resolves.toBeUndefined();
  expect(remove).not.toHaveBeenCalled();
  expect(deleteFiles).not.toHaveBeenCalled();
});
