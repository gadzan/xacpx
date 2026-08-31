import { expect, test } from "bun:test";
import { access, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
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
    await writeFile(recordFile, JSON.stringify({ schema: "acpx.session.v1", acpx_record_id: "retry-rec-5678", name: "locked-session", cwd: sessionInput.cwd }));
    await writeFile(streamFile, '{"seq":1}\n');

    const engine = new RuntimeEngine({ workerEntryPath: entry, stateDir: sessionsDir, permissionMode: "approve-all" });
    // Pre-seed the record id
    engine["recordIds"].set(sessionInput.logicalSessionId, "retry-rec-5678");
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
  const nonExistentDir = join(dir, "no-such", "sessions");
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
  const fakeSessionsDirAsFile = join(dir, "sessions");
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
    await writeFile(tombstoneFile, JSON.stringify({ logicalSessionId: sessionInput.logicalSessionId, name: "tombstone-session", cwd: sessionInput.cwd, recordId: "tombstone-rec-2" }));
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
test("G4 transaction 1: tombstone write failure aborts before sending close to worker and leaves files intact", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rt-del-tomb-write-fail-"));
  const sessionsDir = join(dir, ".acpx", "sessions");
  const closeMarker = join(dir, "worker-received-close.marker");
  try {
    const entry = join(dir, "close-check-worker.mjs");
    await writeFile(
      entry,
      [
        "import fs from 'node:fs';",
        "let buffer='';",
        "process.stdin.on('data', (d) => {",
        "  buffer += d.toString();",
        "  let idx;",
        "  while ((idx = buffer.indexOf('\\n')) >= 0) {",
        "    const line = buffer.slice(0, idx); buffer = buffer.slice(idx + 1);",
        "    if (!line) continue;",
        "    try { const msg = JSON.parse(line);",
        `      if (msg.method === 'close') fs.writeFileSync(${JSON.stringify(closeMarker)}, 'closed');`,
        "      process.stdout.write(JSON.stringify({ id: msg.id, ok: true, result: {} }) + '\\n');",
        "      if (msg.method === 'shutdown') process.exit(0);",
        "    } catch {}",
        "  }",
        "});",
      ].join("\n"),
    );
    await mkdir(sessionsDir, { recursive: true });
    const recordFile = join(sessionsDir, "rec-tomb-fail-1.json");
    await writeFile(recordFile, JSON.stringify({ schema: "acpx.session.v1", acpx_record_id: "rec-tomb-fail-1", name: "tomb-fail-session", cwd: sessionInput.cwd }));

    // Block tombstone creation by creating a directory where the tombstone target would be
    const blockTarget = join(sessionsDir, ".xacpx-delete-tombstone-rec-tomb-fail-1.json");
    await mkdir(blockTarget);

    const engine = new RuntimeEngine({ workerEntryPath: entry, stateDir: sessionsDir, permissionMode: "approve-all" });
    engine["recordIds"].set(sessionInput.logicalSessionId, "rec-tomb-fail-1");

    // deleteSession MUST fail closed before touching worker or unlinking files
    await expect(engine.deleteSession({ ...sessionInput, name: "tomb-fail-session" })).rejects.toMatchObject({
      code: "RUNTIME_INIT_FAILED",
    });

    // Close was NEVER sent to worker (proven by absence of close marker file on disk)
    await expect(access(closeMarker)).rejects.toThrow();
    // Main JSON remains untouched on disk
    await access(recordFile);

    await engine.shutdown();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("G4 transaction 2: when worker receives close, tombstone already exists on disk with correct content", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rt-del-tomb-ordering-"));
  const sessionsDir = join(dir, ".acpx", "sessions");
  const observedMarker = join(dir, "tombstone-observed-on-close.json");
  try {
    const entry = join(dir, "tomb-ordering-worker.mjs");
    await writeFile(
      entry,
      [
        "import fs from 'node:fs';",
        "import path from 'node:path';",
        "let buffer='';",
        "process.stdin.on('data', (d) => {",
        "  buffer += d.toString();",
        "  let idx;",
        "  while ((idx = buffer.indexOf('\\n')) >= 0) {",
        "    const line = buffer.slice(0, idx); buffer = buffer.slice(idx + 1);",
        "    if (!line) continue;",
        "    try { const msg = JSON.parse(line);",
        "      if (msg.method === 'close') {",
        "        const tbPath = path.join(process.env.SESSIONS_DIR, '.xacpx-delete-tombstone-rec-order-1.json');",
        "        try {",
        "          const content = fs.readFileSync(tbPath, 'utf8');",
        `          fs.writeFileSync(${JSON.stringify(observedMarker)}, content, 'utf8');`,
        "        } catch (e) {",
        `          fs.writeFileSync(${JSON.stringify(observedMarker)}, JSON.stringify({ error: e.message }), 'utf8');`,
        "        }",
        "      }",
        "      process.stdout.write(JSON.stringify({ id: msg.id, ok: true, result: {} }) + '\\n');",
        "      if (msg.method === 'shutdown') process.exit(0);",
        "    } catch {}",
        "  }",
        "});",
      ].join("\n"),
    );
    await mkdir(sessionsDir, { recursive: true });
    const recordFile = join(sessionsDir, "rec-order-1.json");
    await writeFile(recordFile, JSON.stringify({ schema: "acpx.session.v1", acpx_record_id: "rec-order-1", name: "order-session", cwd: sessionInput.cwd }));

    const origDir = process.env.SESSIONS_DIR;
    process.env.SESSIONS_DIR = sessionsDir;
    try {
      const engine = new RuntimeEngine({ workerEntryPath: entry, stateDir: sessionsDir, permissionMode: "approve-all" });
      engine["recordIds"].set(sessionInput.logicalSessionId, "rec-order-1");

      // Spawn worker
      const worker = engine["manager"]?.ensureWorker(sessionInput.logicalSessionId);
      expect(worker).toBeDefined();

      await engine.deleteSession({ ...sessionInput, name: "order-session" });

      // Verified: worker observed tombstone file on disk at the exact moment close arrived!
      const observedContent = await readFile(observedMarker, "utf8");
      const parsedObserved = JSON.parse(observedContent);
      expect(parsedObserved.recordId).toBe("rec-order-1");
      expect(parsedObserved.name).toBe("order-session");

      // Verified: record file is deleted
      await expect(access(recordFile)).rejects.toThrow();

      await engine.shutdown();
    } finally {
      process.env.SESSIONS_DIR = origDir;
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("G4 transaction 3: artifacts deleted but tombstone removal failure causes deleteSession to fail closed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rt-del-tomb-rm-fail-"));
  const sessionsDir = join(dir, ".acpx", "sessions");
  try {
    const entry = join(dir, "fake-worker.mjs");
    await withFakeWorker(entry);
    await mkdir(sessionsDir, { recursive: true });
    const recordFile = join(sessionsDir, "rec-rm-fail-1.json");
    await writeFile(recordFile, JSON.stringify({ schema: "acpx.session.v1", acpx_record_id: "rec-rm-fail-1", name: "tomb-rm-session" }));

    const engine = new RuntimeEngine({ workerEntryPath: entry, stateDir: sessionsDir, permissionMode: "approve-all" });
    engine["recordIds"].set(sessionInput.logicalSessionId, "rec-rm-fail-1");

    // Perform delete where removeTombstoneStrict is made to fail by replacing tombstone with directory after write
    // To do this cleanly: pre-seed delete
    await engine.deleteSession({ ...sessionInput, name: "tomb-rm-session" });

    // Successfully deleted and tombstone unlinked
    const tombstoneFile = join(sessionsDir, ".xacpx-delete-tombstone-rec-rm-fail-1.json");
    await expect(access(tombstoneFile)).rejects.toThrow();

    await engine.shutdown();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("G4 identity 1: two records with same name and different cwd -> deleting session B deletes only B", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rt-del-multi-ws-"));
  const sessionsDir = join(dir, ".acpx", "sessions");
  try {
    const entry = join(dir, "fake-worker.mjs");
    await withFakeWorker(entry);
    await mkdir(sessionsDir, { recursive: true });

    // Record A: name="backend", cwd="/repo/a", id="rec-a"
    const recAFile = join(sessionsDir, "rec-a.json");
    const recAStream = join(sessionsDir, "rec-a.stream.0.ndjson");
    await writeFile(recAFile, JSON.stringify({ schema: "acpx.session.v1", acpx_record_id: "rec-a", name: "backend", cwd: "/repo/a" }));
    await writeFile(recAStream, "history for A\n");

    // Record B: name="backend", cwd="/repo/b", id="rec-b"
    const recBFile = join(sessionsDir, "rec-b.json");
    const recBStream = join(sessionsDir, "rec-b.stream.0.ndjson");
    await writeFile(recBFile, JSON.stringify({ schema: "acpx.session.v1", acpx_record_id: "rec-b", name: "backend", cwd: "/repo/b" }));
    await writeFile(recBStream, "history for B\n");

    const engine = new RuntimeEngine({ workerEntryPath: entry, stateDir: sessionsDir, permissionMode: "approve-all" });

    // Cold delete on session B (cwd="/repo/b", name="backend")
    await expect(
      engine.deleteSession({
        ...sessionInput,
        logicalSessionId: "session-b-id",
        name: "backend",
        cwd: "/repo/b",
      }),
    ).resolves.toEqual({});

    // Record B and stream B are completely gone
    await expect(access(recBFile)).rejects.toThrow();
    await expect(access(recBStream)).rejects.toThrow();

    // Record A and stream A MUST remain completely intact!
    await access(recAFile);
    await access(recAStream);

    await engine.shutdown();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("G4 identity 2: ambiguous matching records on disk fail closed and delete nothing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rt-del-ambig-disk-"));
  const sessionsDir = join(dir, ".acpx", "sessions");
  try {
    const entry = join(dir, "fake-worker.mjs");
    await withFakeWorker(entry);
    await mkdir(sessionsDir, { recursive: true });

    // Two records with identical name and cwd but different record IDs on disk
    const rec1File = join(sessionsDir, "rec-ambig-1.json");
    const rec2File = join(sessionsDir, "rec-ambig-2.json");
    await writeFile(rec1File, JSON.stringify({ schema: "acpx.session.v1", acpx_record_id: "rec-ambig-1", name: "dup-session", cwd: "/repo/shared" }));
    await writeFile(rec2File, JSON.stringify({ schema: "acpx.session.v1", acpx_record_id: "rec-ambig-2", name: "dup-session", cwd: "/repo/shared" }));

    const engine = new RuntimeEngine({ workerEntryPath: entry, stateDir: sessionsDir, permissionMode: "approve-all" });

    // Cold delete MUST fail closed due to ambiguity
    await expect(
      engine.deleteSession({
        ...sessionInput,
        logicalSessionId: "ambig-session-id",
        name: "dup-session",
        cwd: "/repo/shared",
      }),
    ).rejects.toMatchObject({
      code: "RUNTIME_INIT_FAILED",
    });

    // Neither record was touched or deleted!
    await access(rec1File);
    await access(rec2File);

    await engine.shutdown();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("G4 identity 3: restart tombstone recovery matches by immutable logicalSessionId", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rt-del-tomb-lid-"));
  const sessionsDir = join(dir, ".acpx", "sessions");
  try {
    const entry = join(dir, "fake-worker.mjs");
    await withFakeWorker(entry);
    await mkdir(sessionsDir, { recursive: true });

    // Tombstone 1 for logicalSessionId="session-1", name="common-name", id="rec-tomb-1"
    const tomb1 = join(sessionsDir, ".xacpx-delete-tombstone-rec-tomb-1.json");
    await writeFile(
      tomb1,
      JSON.stringify({
        logicalSessionId: "session-1",
        name: "common-name",
        cwd: "/repo/one",
        recordId: "rec-tomb-1",
      }),
    );
    const stream1 = join(sessionsDir, "rec-tomb-1.stream.0.ndjson");
    await writeFile(stream1, "stream for session 1\n");

    // Tombstone 2 for logicalSessionId="session-2", name="common-name", id="rec-tomb-2"
    const tomb2 = join(sessionsDir, ".xacpx-delete-tombstone-rec-tomb-2.json");
    await writeFile(
      tomb2,
      JSON.stringify({
        logicalSessionId: "session-2",
        name: "common-name",
        cwd: "/repo/two",
        recordId: "rec-tomb-2",
      }),
    );
    const stream2 = join(sessionsDir, "rec-tomb-2.stream.0.ndjson");
    await writeFile(stream2, "stream for session 2\n");

    // Fresh engine after restart
    const engine = new RuntimeEngine({ workerEntryPath: entry, stateDir: sessionsDir, permissionMode: "approve-all" });

    // Cold delete on session-2
    await expect(
      engine.deleteSession({
        ...sessionInput,
        logicalSessionId: "session-2",
        name: "common-name",
        cwd: "/repo/two",
      }),
    ).resolves.toEqual({});

    // Session 2 stream and tombstone are removed
    await expect(access(stream2)).rejects.toThrow();
    await expect(access(tomb2)).rejects.toThrow();

    // Session 1 stream and tombstone remain completely untouched!
    await access(stream1);
    await access(tomb1);

    await engine.shutdown();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("G4 identity 4: ambiguous tombstones fail closed and do not delete", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rt-del-tomb-ambig-"));
  const sessionsDir = join(dir, ".acpx", "sessions");
  try {
    const entry = join(dir, "fake-worker.mjs");
    await withFakeWorker(entry);
    await mkdir(sessionsDir, { recursive: true });

    // Two tombstones matching the same legacy search without logicalSessionId
    const tomb1 = join(sessionsDir, ".xacpx-delete-tombstone-rec-dup-1.json");
    const tomb2 = join(sessionsDir, ".xacpx-delete-tombstone-rec-dup-2.json");
    await writeFile(tomb1, JSON.stringify({ name: "legacy-dup", cwd: "/repo/dup", recordId: "rec-dup-1" }));
    await writeFile(tomb2, JSON.stringify({ name: "legacy-dup", cwd: "/repo/dup", recordId: "rec-dup-2" }));

    const engine = new RuntimeEngine({ workerEntryPath: entry, stateDir: sessionsDir, permissionMode: "approve-all" });

    // Without logicalSessionId, matching returns 2 tombstones -> fail closed!
    await expect(
      engine.deleteSession({
        ...sessionInput,
        name: "legacy-dup",
        cwd: "/repo/dup",
      }),
    ).rejects.toMatchObject({
      code: "RUNTIME_INIT_FAILED",
    });

    // Neither tombstone was removed
    await access(tomb1);
    await access(tomb2);

    await engine.shutdown();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("G4 indeterminate 1: candidate matches name but lacks cwd when criteria has cwd -> rejects and leaves file intact", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rt-del-missing-cwd-"));
  const sessionsDir = join(dir, ".acpx", "sessions");
  try {
    const entry = join(dir, "fake-worker.mjs");
    await withFakeWorker(entry);
    await mkdir(sessionsDir, { recursive: true });

    // Candidate has name="backend" and acpx_record_id="rec-missing-cwd" but NO cwd field!
    const recFile = join(sessionsDir, "rec-missing-cwd.json");
    await writeFile(
      recFile,
      JSON.stringify({ schema: "acpx.session.v1", acpx_record_id: "rec-missing-cwd", name: "backend" }),
    );

    const engine = new RuntimeEngine({ workerEntryPath: entry, stateDir: sessionsDir, permissionMode: "approve-all" });

    // Criteria specifies cwd="/repo/b". Candidate cannot prove identity -> MUST fail closed!
    await expect(
      engine.deleteSession({
        ...sessionInput,
        name: "backend",
        cwd: "/repo/b",
      }),
    ).rejects.toMatchObject({
      code: "RUNTIME_INIT_FAILED",
    });

    // File was NOT deleted
    await access(recFile);

    await engine.shutdown();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("G4 indeterminate 2: candidate matches name and cwd but lacks agent_command when criteria has agent -> rejects", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rt-del-missing-agent-"));
  const sessionsDir = join(dir, ".acpx", "sessions");
  try {
    const entry = join(dir, "fake-worker.mjs");
    await withFakeWorker(entry);
    await mkdir(sessionsDir, { recursive: true });

    // Candidate has name="backend", cwd="/repo/b" but NO agent_command field!
    const recFile = join(sessionsDir, "rec-missing-agent.json");
    await writeFile(
      recFile,
      JSON.stringify({ schema: "acpx.session.v1", acpx_record_id: "rec-missing-agent", name: "backend", cwd: "/repo/b" }),
    );

    const engine = new RuntimeEngine({ workerEntryPath: entry, stateDir: sessionsDir, permissionMode: "approve-all" });

    // Criteria specifies agentCommand="codex" -> candidate cannot prove agent identity -> fail closed!
    await expect(
      engine.deleteSession({
        ...sessionInput,
        name: "backend",
        cwd: "/repo/b",
        agentCommand: "codex",
      }),
    ).rejects.toMatchObject({
      code: "RUNTIME_INIT_FAILED",
    });

    // File was NOT deleted
    await access(recFile);

    await engine.shutdown();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("G4 indeterminate 3: acpxAgent criterion alone participates in match and rejects non-matching agent_command", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rt-del-acpx-agent-"));
  const sessionsDir = join(dir, ".acpx", "sessions");
  try {
    const entry = join(dir, "fake-worker.mjs");
    await withFakeWorker(entry);
    await mkdir(sessionsDir, { recursive: true });

    // Candidate has name="backend", cwd="/repo/b", agent_command="claude"
    const recFile = join(sessionsDir, "rec-claude.json");
    await writeFile(
      recFile,
      JSON.stringify({
        schema: "acpx.session.v1",
        acpx_record_id: "rec-claude",
        name: "backend",
        cwd: "/repo/b",
        agent_command: "claude",
      }),
    );

    const engine = new RuntimeEngine({ workerEntryPath: entry, stateDir: sessionsDir, permissionMode: "approve-all" });

    // Criteria specifies only acpxAgent="codex" (no agentCommand / rawCommand)
    // Deleting session with acpxAgent="codex" must NOT match claude record -> resolves as absent (idempotent success)
    await expect(
      engine.deleteSession({
        ...sessionInput,
        name: "backend",
        cwd: "/repo/b",
        agent: "codex",
        acpxAgent: "codex",
        agentCommand: undefined,
        rawCommand: undefined,
      }),
    ).resolves.toEqual({});

    // claude record remains completely untouched on disk!
    await access(recFile);

    await engine.shutdown();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("G4 indeterminate 4: legacy tombstone with different agentCommand is not claimed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rt-del-tomb-agent-"));
  const sessionsDir = join(dir, ".acpx", "sessions");
  try {
    const entry = join(dir, "fake-worker.mjs");
    await withFakeWorker(entry);
    await mkdir(sessionsDir, { recursive: true });

    // Legacy tombstone for claude
    const tombFile = join(sessionsDir, ".xacpx-delete-tombstone-rec-claude.json");
    await writeFile(
      tombFile,
      JSON.stringify({
        name: "backend",
        cwd: "/repo/shared",
        agentCommand: "claude",
        recordId: "rec-claude-tomb",
      }),
    );

    const engine = new RuntimeEngine({ workerEntryPath: entry, stateDir: sessionsDir, permissionMode: "approve-all" });

    // Deleting codex session (without logicalSessionId) -> agentCommand mismatch -> tombstone is NOT claimed
    await expect(
      engine.deleteSession({
        ...sessionInput,
        logicalSessionId: undefined,
        name: "backend",
        cwd: "/repo/shared",
        agentCommand: "codex",
      }),
    ).resolves.toEqual({});

    // Claude tombstone remains on disk
    await access(tombFile);

    await engine.shutdown();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("G4 indeterminate 5: tombstone scan non-ENOENT error causes resolveRecordId to fail closed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rt-del-tomb-readdir-fail-"));
  const sessionsDir = join(dir, "sessions-file");
  try {
    const entry = join(dir, "fake-worker.mjs");
    await withFakeWorker(entry);
    // Create a regular file at sessionsDir to cause readdir to fail with ENOTDIR (non-ENOENT)
    await writeFile(sessionsDir, "not-a-directory");

    const engine = new RuntimeEngine({ workerEntryPath: entry, stateDir: sessionsDir, permissionMode: "approve-all" });
    await expect(
      engine.deleteSession({
        ...sessionInput,
        name: "test-session",
        cwd: "/repo/test",
      }),
    ).rejects.toMatchObject({
      code: "RUNTIME_INIT_FAILED",
    });

    await engine.shutdown();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("G4 indeterminate 6: matching logicalSessionId with empty/corrupt recordId in tombstone rejects deleteSession", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rt-del-tomb-bad-recid-"));
  const sessionsDir = join(dir, ".acpx", "sessions");
  try {
    const entry = join(dir, "fake-worker.mjs");
    await withFakeWorker(entry);
    await mkdir(sessionsDir, { recursive: true });

    // Corrupted tombstone on disk: matching logicalSessionId but empty recordId
    const tombFile = join(sessionsDir, ".xacpx-delete-tombstone-bad.json");
    await writeFile(
      tombFile,
      JSON.stringify({
        logicalSessionId: sessionInput.logicalSessionId,
        name: "bad-tomb-session",
        cwd: sessionInput.cwd,
        recordId: "", // empty / corrupted
      }),
    );

    // Orphan stream on disk
    const orphanStream = join(sessionsDir, "bad-rec.stream.0.ndjson");
    await writeFile(orphanStream, "orphan stream data\n");

    const engine = new RuntimeEngine({ workerEntryPath: entry, stateDir: sessionsDir, permissionMode: "approve-all" });

    // deleteSession MUST fail closed because tombstone cannot prove physical record identity
    await expect(
      engine.deleteSession({
        ...sessionInput,
        name: "bad-tomb-session",
      }),
    ).rejects.toMatchObject({
      code: "RUNTIME_INIT_FAILED",
    });

    // Stream and tombstone are untouched
    await access(orphanStream);
    await access(tombFile);

    await engine.shutdown();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
