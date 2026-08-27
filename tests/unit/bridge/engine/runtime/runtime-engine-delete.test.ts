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
    expect(await findAcpxRecordIdFromDisk("target-session-name", dir)).toEqual({
      kind: "found",
      recordId: "019cf-test-rec",
    });
    expect(await findAcpxRecordIdFromDisk("non-existent-session", dir)).toEqual({ kind: "absent" });
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
    const streamFile = join(sessionsDir, "retry-rec-5678.stream.1.ndjson");
    await writeFile(recordFile, JSON.stringify({ schema: "acpx.session.v1", acpx_record_id: "retry-rec-5678", name: "locked-session" }));
    await writeFile(streamFile, '{"seq":1}\n');

    const engine = new RuntimeEngine({ workerEntryPath: entry, stateDir: sessionsDir, permissionMode: "approve-all" });
    // Pre-seed the record id
    engine["recordIds"].set("locked-session", "retry-rec-5678");

    // Perform strict delete: retry loop ensures ALL record and stream files are genuinely gone
    await engine.deleteSession({ ...sessionInput, name: "locked-session" });
    await expect(access(recordFile)).rejects.toThrow();
    await expect(access(streamFile)).rejects.toThrow();
    await engine.shutdown();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("G4: deleteSession fails closed if main JSON is deleted but stream artifacts persist", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rt-del-stream-fail-"));
  const sessionsDir = join(dir, ".acpx", "sessions");
  try {
    const entry = join(dir, "fake-worker.mjs");
    await withFakeWorker(entry);
    await mkdir(sessionsDir, { recursive: true });

    const engine = new RuntimeEngine({ workerEntryPath: entry, stateDir: sessionsDir, permissionMode: "approve-all" });
    const recordFile = join(sessionsDir, "stubborn-rec-9999.json");
    await writeFile(recordFile, JSON.stringify({ schema: "acpx.session.v1", acpx_record_id: "stubborn-rec-9999", name: "stubborn-session" }));
    engine["recordIds"].set(sessionInput.logicalSessionId, "stubborn-rec-9999");

    // Create an un-unlinkable artifact (directory shape causes unlink to fail with EISDIR/EPERM)
    const streamFile = join(sessionsDir, "stubborn-rec-9999.stream.0.ndjson");
    await mkdir(streamFile);

    // Stub deleteAcpxSessionFiles to delete nothing
    // readdir will always find the stream file -> deadline throws with exact filename
    const promise = engine.deleteSession({ ...sessionInput, name: "stubborn-session" });

    // Since deleteRecordFilesStrict retries for 5s, we can assert it rejects with the remaining artifact name
    await expect(promise).rejects.toThrow(/artifact\(s\) still remaining.*stubborn-rec-9999\.stream\.0\.ndjson/);
    await engine.shutdown();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 10_000);

test("G4 fail-closed 1: sessions directory ENOENT allows idempotent delete success", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rt-del-enoent-"));
  const nonExistentDir = join(dir, "no-such-sessions-dir");
  try {
    const entry = join(dir, "fake-worker.mjs");
    await withFakeWorker(entry);

    const engine = new RuntimeEngine({
      workerEntryPath: entry,
      stateDir: nonExistentDir,
      permissionMode: "approve-all",
    });

    // ENOENT proves the directory / records are absent -> idempotent success
    await expect(engine.deleteSession(sessionInput)).resolves.toEqual({});
    await engine.shutdown();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("G4 fail-closed 2: cold lookup unreadable directory (non-ENOENT) fails closed and rejects delete", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rt-del-unreadable-dir-"));
  const fakeSessionsDirAsFile = join(dir, "sessions-is-a-file");
  try {
    const entry = join(dir, "fake-worker.mjs");
    await withFakeWorker(entry);
    // Creating a file where a directory is expected causes readdir to throw ENOTDIR (non-ENOENT)
    await writeFile(fakeSessionsDirAsFile, "not-a-directory");

    const engine = new RuntimeEngine({
      workerEntryPath: entry,
      stateDir: fakeSessionsDirAsFile,
      permissionMode: "approve-all",
    });

    // Cannot verify whether session existed -> MUST fail closed!
    await expect(engine.deleteSession(sessionInput)).rejects.toMatchObject({
      code: "RUNTIME_INIT_FAILED",
    });
    await engine.shutdown();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("G4 fail-closed 3: unreadable candidate file during cold lookup fails closed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rt-del-unreadable-file-"));
  const sessionsDir = join(dir, ".acpx", "sessions");
  try {
    const entry = join(dir, "fake-worker.mjs");
    await withFakeWorker(entry);
    await mkdir(sessionsDir, { recursive: true });

    // A candidate record file that is actually a directory causes readFile to throw EISDIR
    const unreadableCandidate = join(sessionsDir, "corrupt-candidate.json");
    await mkdir(unreadableCandidate);

    const lookup = await findAcpxRecordIdFromDisk("any-session", sessionsDir);
    expect(lookup.kind).toBe("failed");

    const engine = new RuntimeEngine({
      workerEntryPath: entry,
      stateDir: sessionsDir,
      permissionMode: "approve-all",
    });

    await expect(engine.deleteSession({ ...sessionInput, name: "any-session" })).rejects.toMatchObject({
      code: "RUNTIME_INIT_FAILED",
    });
    await engine.shutdown();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("G4 recovery: partial delete failure retains recordId in memory so second delete removes stream and succeeds", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rt-del-partial-recovery-"));
  const sessionsDir = join(dir, ".acpx", "sessions");
  try {
    const entry = join(dir, "fake-worker.mjs");
    await withFakeWorker(entry);
    await mkdir(sessionsDir, { recursive: true });

    const engine = new RuntimeEngine({ workerEntryPath: entry, stateDir: sessionsDir, permissionMode: "approve-all" });
    const recordFile = join(sessionsDir, "partial-rec-1.json");
    await writeFile(recordFile, JSON.stringify({ schema: "acpx.session.v1", acpx_record_id: "partial-rec-1", name: "partial-session" }));
    engine["recordIds"].set(sessionInput.logicalSessionId, "partial-rec-1");

    // Make stream initially un-unlinkable (stubborn directory)
    const streamDir = join(sessionsDir, "partial-rec-1.stream.0.ndjson");
    await mkdir(streamDir);

    // 1. First delete: main JSON is unlinked, but stream fails -> deleteSession rejects
    await expect(engine.deleteSession({ ...sessionInput, name: "partial-session" })).rejects.toThrow(/artifact\(s\) still remaining/);
    // Main JSON is gone from disk
    await expect(access(recordFile)).rejects.toThrow();

    // 2. Unblock the stream artifact (remove directory and replace with normal unlinkable file)
    await rm(streamDir, { recursive: true, force: true });
    const streamFile = join(sessionsDir, "partial-rec-1.stream.0.ndjson");
    await writeFile(streamFile, "stream data");

    // 3. Second delete on the SAME engine: must NOT consider record absent!
    // It must remember partial-rec-1, delete the stream file, and succeed!
    await expect(engine.deleteSession({ ...sessionInput, name: "partial-session" })).resolves.toEqual({});
    await expect(access(streamFile)).rejects.toThrow();

    await engine.shutdown();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 15_000);

test("G4 recovery across restart: tombstone allows cold delete to find recordId even after main JSON is gone", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rt-del-tombstone-restart-"));
  const sessionsDir = join(dir, ".acpx", "sessions");
  try {
    const entry = join(dir, "fake-worker.mjs");
    await withFakeWorker(entry);
    await mkdir(sessionsDir, { recursive: true });

    // Simulate state on disk after a partial delete + daemon restart:
    // Main JSON is gone, stream file remains, tombstone file is present on disk
    const streamFile = join(sessionsDir, "tombstone-rec-2.stream.0.ndjson");
    await writeFile(streamFile, "orphan stream data");

    const tombstoneFile = join(sessionsDir, ".xacpx-delete-tombstone-tombstone-rec-2.json");
    await writeFile(tombstoneFile, JSON.stringify({ name: "tombstone-session", recordId: "tombstone-rec-2" }));

    // Fresh RuntimeEngine instance (simulating restart: memory cache is empty)
    const freshEngine = new RuntimeEngine({ workerEntryPath: entry, stateDir: sessionsDir, permissionMode: "approve-all" });

    // deleteSession on the fresh engine finds tombstone-rec-2 via tombstone, removes stream, and cleans tombstone!
    await expect(freshEngine.deleteSession({ ...sessionInput, name: "tombstone-session" })).resolves.toEqual({});

    // Both the stream file AND the tombstone file are gone
    await expect(access(streamFile)).rejects.toThrow();
    await expect(access(tombstoneFile)).rejects.toThrow();

    await freshEngine.shutdown();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
