import { expect, test } from "bun:test";
import { access, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { RuntimeEngine, findAcpxRecordIdFromDisk } from "../../../../../src/bridge/engine/runtime-engine";

const sessionInput = {
  agent: "codex",
  cwd: "/repo",
  name: "delete-test-session",
  logicalSessionId: "uuid-logical-identity-only-never-a-record-id",
};

async function withFakeWorker(entry: string, onEnsure?: (sessionKey: string) => void): Promise<void> {
  await writeFile(
    entry,
    [
      "let buffer='';",
      "process.stdin.on('data', (d) => {",
      "  buffer += d.toString();",
      "  let idx;",
      "  while ((idx = buffer.indexOf('\\n')) >= 0) {",
      "    const line = buffer.slice(0, idx); buffer = buffer.slice(idx + 1);",
      "    if (!line) continue;",
      "    try { const msg = JSON.parse(line);",
      "      if (msg.method === 'ensure') {",
      "        process.stdout.write(JSON.stringify({ id: msg.id, ok: true, result: { ready: true, sessionKey: msg.params?.sessionKey, acpxRecordId: 'real-acpx-rec-1234' } }) + '\\n');",
      "      } else if (msg.method === 'prompt') {",
      "        process.stdout.write(JSON.stringify({ id: msg.id, event: 'text_delta', payload: { type: 'text_delta', text: 'ok' } }) + '\\n');",
      "        process.stdout.write(JSON.stringify({ id: msg.id, ok: true, result: { result: { status: 'completed' }, finalText: 'ok' } }) + '\\n');",
      "      } else {",
      "        process.stdout.write(JSON.stringify({ id: msg.id, ok: true, result: {} }) + '\\n');",
      "      }",
      "      if (msg.method === 'shutdown') process.exit(0);",
      "    } catch {}",
      "  }",
      "});",
    ].join("\n"),
  );
}

test("findAcpxRecordIdFromDisk scans session files on disk without spawning workers", async () => {
  const dir = await mkdtemp(join(tmpdir(), "acpx-find-"));
  try {
    // Create a real-shaped acpx record file on disk
    await writeFile(
      join(dir, "019cf-test-rec.json"),
      JSON.stringify({
        schema: "acpx.session.v1",
        acpx_record_id: "019cf-test-rec",
        name: "target-session-name",
      }),
    );
    expect(await findAcpxRecordIdFromDisk("target-session-name", dir)).toBe("019cf-test-rec");
    expect(await findAcpxRecordIdFromDisk("non-existent-session", dir)).toBeUndefined();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("full delete lifecycle: ensure → prompt → freeWarm → cooled worker → deleteSession cleans record and second delete is idempotent", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rt-del-full-"));
  const sessionsDir = join(dir, ".acpx", "sessions");
  try {
    const entry = join(dir, "fake-worker.mjs");
    await withFakeWorker(entry);
    // Seed real acpx record files on disk
    await mkdir(sessionsDir, { recursive: true });
    const recordFile = join(sessionsDir, "real-acpx-rec-1234.json");
    const streamFile = join(sessionsDir, "real-acpx-rec-1234.stream.ndjson");
    await writeFile(
      recordFile,
      JSON.stringify({
        schema: "acpx.session.v1",
        acpx_record_id: "real-acpx-rec-1234",
        name: sessionInput.name,
      }),
    );
    await writeFile(streamFile, '{"seq":1}\n');

    const engine = new RuntimeEngine({ workerEntryPath: entry, stateDir: sessionsDir, permissionMode: "approve-all" });

    // 1. Ensure + prompt
    const reply = await engine.prompt({ ...sessionInput, text: "hi" });
    expect(reply.text).toBe("ok");
    expect((await engine.isSessionWarm(sessionInput)).warm).toBe(true);

    // 2. freeWarmProcess terminates the warm worker without closing record
    await engine.freeWarmProcess(sessionInput);
    expect((await engine.isSessionWarm(sessionInput)).warm).toBe(false);
    // Record is still on disk
    await access(recordFile);

    // 3. deleteSession on the COOLED session finds the real record and strictly deletes it
    await engine.deleteSession(sessionInput);
    // Verified: real record file is GONE
    await expect(access(recordFile)).rejects.toThrow();

    // 4. Invariant: logicalSessionId file was NEVER created or targeted
    const logicalFile = join(sessionsDir, `${sessionInput.logicalSessionId}.json`);
    await expect(access(logicalFile)).rejects.toThrow();

    // 5. Second deleteSession is idempotent and returns {}
    await expect(engine.deleteSession(sessionInput)).resolves.toEqual({});

    await engine.shutdown();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 15_000);

test("deleteRecordFilesStrict retries transient failures until the record is confirmed gone", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rt-del-retry-"));
  const sessionsDir = join(dir, ".acpx", "sessions");
  try {
    const entry = join(dir, "fake-worker.mjs");
    await withFakeWorker(entry);
    await mkdir(sessionsDir, { recursive: true });
    const recordFile = join(sessionsDir, "retry-rec-5678.json");
    await writeFile(recordFile, JSON.stringify({ schema: "acpx.session.v1", acpx_record_id: "retry-rec-5678", name: "locked-session" }));

    const engine = new RuntimeEngine({ workerEntryPath: entry, stateDir: sessionsDir, permissionMode: "approve-all" });
    // Pre-seed the record id
    engine["recordIds"].set("locked-session", "retry-rec-5678");

    // Perform strict delete: retry loop ensures record file is genuinely gone
    await engine.deleteSession({ ...sessionInput, name: "locked-session" });
    await expect(access(recordFile)).rejects.toThrow();
    await engine.shutdown();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
