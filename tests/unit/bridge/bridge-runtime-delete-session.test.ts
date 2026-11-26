import { afterAll, expect, mock, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BridgeRuntime } from "../../../src/bridge/bridge-runtime";

// `deleteSession` ends by deleting the acpx record files on disk. Redirect
// acpx's home (`resolveAcpxHomeDir` is env-first exactly for this) and assert on
// real files instead of stubbing the module: bun's `mock.module` is
// process-global and irreversible, so stubbing `acpx-session-files` here breaks
// the real `deleteAcpxSessionFiles` tests whenever both files share a process.
const previousHome = process.env.HOME;
const previousUserProfile = process.env.USERPROFILE;
const scratchHome = mkdtempSync(join(tmpdir(), "xacpx-delete-session-home-"));
const sessionsDir = join(scratchHome, ".acpx", "sessions");
process.env.HOME = scratchHome;
process.env.USERPROFILE = scratchHome;

afterAll(() => {
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  if (previousUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = previousUserProfile;
  rmSync(scratchHome, { recursive: true, force: true });
});

const input = { agent: "codex", cwd: "/repo", name: "demo" };
const recordId = "019d009c-1111-7000-8000-aaaaaaaaaaaa";

/** Fresh sessions dir holding one record's json + stream artifacts. */
function plantRecordFiles(): { record: string; stream: string } {
  rmSync(sessionsDir, { recursive: true, force: true });
  mkdirSync(sessionsDir, { recursive: true });
  const safe = encodeURIComponent(recordId);
  const record = join(sessionsDir, `${safe}.json`);
  const stream = join(sessionsDir, `${safe}.stream.ndjson`);
  writeFileSync(record, "{}");
  writeFileSync(stream, "");
  return { record, stream };
}

test("deleteSession closes then deletes files by acpxRecordId", async () => {
  const { record, stream } = plantRecordFiles();
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
  // Then the on-disk record files for the resolved record id are gone.
  expect(existsSync(record)).toBe(false);
  expect(existsSync(stream)).toBe(false);
});

test("deleteSession is a no-op when the record can't be resolved", async () => {
  const { record, stream } = plantRecordFiles();
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
  expect(existsSync(record)).toBe(true);
  expect(existsSync(stream)).toBe(true);
});

test("deleteSession treats a malformed record id as unresolvable (no delete)", async () => {
  const { record, stream } = plantRecordFiles();
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
  expect(existsSync(record)).toBe(true);
  expect(existsSync(stream)).toBe(true);
});
