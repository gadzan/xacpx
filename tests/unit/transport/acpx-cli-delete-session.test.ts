import { afterEach, beforeEach, expect, spyOn, mock, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

const originalHome = process.env.HOME;
let home = "";
let sessionsDir = "";

// The file delete is the behavior under test, so it runs for real against a
// throwaway acpx home instead of a module mock: Bun's module mocks outlive the
// test file and would hand a stub to any sibling suite that runs later.
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "acpx-delete-session-"));
  process.env.HOME = home;
  sessionsDir = join(home, ".acpx", "sessions");
});

afterEach(async () => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  await rm(home, { recursive: true, force: true });
});

async function seedRecord(recordId: string): Promise<void> {
  const safe = encodeURIComponent(recordId);
  await mkdir(sessionsDir, { recursive: true });
  for (const name of [`${safe}.json`, `${safe}.stream.ndjson`, `${safe}.stream.lock`]) {
    await writeFile(join(sessionsDir, name), "");
  }
}

function makeTransport() {
  const run = mock(async () => ({ code: 0, stdout: "", stderr: "" }));
  const runPty = mock(async () => ({ code: 0, stdout: "", stderr: "" }));
  return new AcpxCliTransport({ command: "acpx" }, run, runPty);
}

test("deleteSession closes then deletes files by acpxRecordId", async () => {
  const recordId = "ws:rec-123";
  await seedRecord(recordId);
  const transport = makeTransport();

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
  expect(await readdir(sessionsDir)).toEqual([]);
});

test("deleteSession is a no-op when the session can't be resolved", async () => {
  const recordId = "ws:rec-123";
  await seedRecord(recordId);
  const transport = makeTransport();

  spyOn(transport as never, "readSessionRecord").mockRejectedValue(new Error("no session") as never);
  const remove = spyOn(transport, "removeSession" as never).mockResolvedValue(undefined as never);

  await expect(transport.deleteSession?.(session)).resolves.toBeUndefined();
  expect(remove).not.toHaveBeenCalled();
  expect((await readdir(sessionsDir)).length).toBe(3);
});
