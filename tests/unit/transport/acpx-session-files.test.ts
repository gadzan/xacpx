import { test, expect } from "bun:test";
import { promises as fs } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { deleteAcpxSessionFiles } from "../../../src/transport/acpx-session-files";

async function tempSessionsDir(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "acpx-sessions-"));
}

test("deleteAcpxSessionFiles removes the record json and its stream artifacts", async () => {
  const dir = await tempSessionsDir();
  const id = "ws:demo";
  const safe = encodeURIComponent(id);
  await writeFile(join(dir, `${safe}.json`), "{}");
  await writeFile(join(dir, `${safe}.stream.ndjson`), "");
  await writeFile(join(dir, `${safe}.stream.lock`), "");
  await deleteAcpxSessionFiles({ acpxRecordId: id, sessionsDir: dir });
  expect(await fs.readdir(dir)).toHaveLength(0);
});

test("deleteAcpxSessionFiles is idempotent when nothing exists", async () => {
  const dir = await tempSessionsDir();
  await expect(deleteAcpxSessionFiles({ acpxRecordId: "ws:none", sessionsDir: dir })).resolves.toBeUndefined();
});

test("deleteAcpxSessionFiles only deletes the target session's files, not siblings", async () => {
  const dir = await tempSessionsDir();
  await writeFile(join(dir, `${encodeURIComponent("ws:keep")}.json`), "{}");
  await writeFile(join(dir, `${encodeURIComponent("ws:gone")}.json`), "{}");
  await deleteAcpxSessionFiles({ acpxRecordId: "ws:gone", sessionsDir: dir });
  expect(await fs.readdir(dir)).toEqual([`${encodeURIComponent("ws:keep")}.json`]);
});
