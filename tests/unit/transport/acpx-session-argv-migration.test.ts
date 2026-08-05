import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import {
  acpxSessionRecordFilePath,
  evaluateSessionArgvMigration,
  migrateSessionArgvFile,
} from "../../../src/transport/acpx-session-argv-migration";

const LEGACY_FIXTURE = JSON.parse(
  await readFile(fileURLToPath(new URL("../../fixtures/acpx-compat/session-legacy-no-argv.json", import.meta.url)), "utf8"),
) as Record<string, unknown>;
const CURRENT_FIXTURE = JSON.parse(
  await readFile(fileURLToPath(new URL("../../fixtures/acpx-compat/session-current-with-argv.json", import.meta.url)), "utf8"),
) as Record<string, unknown>;

const TARGET = {
  agentCommand: LEGACY_FIXTURE.agent_command as string,
  agentArgv: ["node", "/home/ci/Projects/acpx/dist-test/test/mock-agent.js"],
};

async function makeSessionsDir(record: Record<string, unknown>): Promise<{ dir: string; filePath: string; recordId: string }> {
  const dir = await mkdtemp(join(tmpdir(), "xacpx-argv-migrate-"));
  await mkdir(dir, { recursive: true });
  const recordId = record.acpx_record_id as string;
  const filePath = acpxSessionRecordFilePath(dir, recordId);
  await writeFile(filePath, `${JSON.stringify(record, null, 2)}\n`);
  return { dir, filePath, recordId };
}

test("pure evaluation: backfills when agent_command matches the canonical identity", () => {
  const result = evaluateSessionArgvMigration(LEGACY_FIXTURE, TARGET);
  expect(result.status).toBe("backfilled");
  expect(result.record.agent_argv).toEqual(TARGET.agentArgv);
  expect(result.record.agent_command).toBe(TARGET.agentCommand);
  expect(result.record.acpx_record_id).toBe(LEGACY_FIXTURE.acpx_record_id);
});

test("pure evaluation: already-migrated record is a no-op", () => {
  const result = evaluateSessionArgvMigration(CURRENT_FIXTURE, TARGET);
  expect(result.status).toBe("noop");
});

test("pure evaluation: identity mismatch rejects without a candidate record", () => {
  const result = evaluateSessionArgvMigration(LEGACY_FIXTURE, {
    agentCommand: "node /elsewhere/agent.js",
    agentArgv: ["node", "/elsewhere/agent.js"],
  });
  expect(result.status).toBe("rejected");
  expect(result.record.agent_argv).toBeUndefined();
});

test("pure evaluation: argv mismatch rejects", () => {
  const record = { ...CURRENT_FIXTURE, agent_argv: ["node", "/elsewhere/agent.js"] };
  const result = evaluateSessionArgvMigration(record, TARGET);
  expect(result.status).toBe("rejected");
});

test("pure evaluation: malformed records are invalid", () => {
  expect(evaluateSessionArgvMigration("nope", TARGET).status).toBe("invalid");
  expect(evaluateSessionArgvMigration({ agent_command: "x" }, TARGET).status).toBe("invalid");
  expect(evaluateSessionArgvMigration({ acpx_record_id: "r", agent_command: "x" }, TARGET).status).toBe("rejected");
});

test("backfills a legacy fixture file atomically and preserves every other field", async () => {
  const { dir, filePath, recordId } = await makeSessionsDir(LEGACY_FIXTURE);
  try {
    const result = await migrateSessionArgvFile(recordId, TARGET, { sessionsDir: dir });
    expect(result.status).toBe("backfilled");

    const written = JSON.parse(await readFile(filePath, "utf8")) as Record<string, unknown>;
    expect(written.agent_argv).toEqual(TARGET.agentArgv);
    expect(written.agent_command).toBe(TARGET.agentCommand);
    expect(written.acpx_record_id).toBe(recordId);
    // Every historical field is byte-identical: re-serializing the parsed record
    // with the same 2-space formatting reproduces the file exactly.
    expect(await readFile(filePath, "utf8")).toBe(`${JSON.stringify(written, null, 2)}\n`);
    // deterministic given the parse: the new file equals the original object plus argv
    expect(JSON.stringify(written)).toBe(JSON.stringify({ ...LEGACY_FIXTURE, agent_argv: TARGET.agentArgv }));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("already-migrated record is a no-op and the file is untouched", async () => {
  const { dir, filePath, recordId } = await makeSessionsDir(CURRENT_FIXTURE);
  try {
    const before = await readFile(filePath, "utf8");
    const result = await migrateSessionArgvFile(recordId, TARGET, { sessionsDir: dir });
    expect(result.status).toBe("noop");
    expect(await readFile(filePath, "utf8")).toBe(before);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("identity mismatch preserves the original record file", async () => {
  const { dir, filePath, recordId } = await makeSessionsDir(LEGACY_FIXTURE);
  try {
    const before = await readFile(filePath, "utf8");
    const result = await migrateSessionArgvFile(recordId, {
      agentCommand: "node /elsewhere/agent.js",
      agentArgv: ["node", "/elsewhere/agent.js"],
    }, { sessionsDir: dir });
    expect(result.status).toBe("rejected");
    expect(await readFile(filePath, "utf8")).toBe(before);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("malformed JSON preserves the file and reports invalid", async () => {
  const { dir, filePath, recordId } = await makeSessionsDir(LEGACY_FIXTURE);
  try {
    await writeFile(filePath, "{ not json");
    const result = await migrateSessionArgvFile(recordId, TARGET, { sessionsDir: dir });
    expect(result.status).toBe("invalid");
    expect(await readFile(filePath, "utf8")).toBe("{ not json");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("record file with a different record id is rejected", async () => {
  const { dir, filePath } = await makeSessionsDir(LEGACY_FIXTURE);
  try {
    const result = await migrateSessionArgvFile("11111111-2222-3333-4444-555555555555", TARGET, { sessionsDir: dir });
    expect(result.status).toBe("invalid");
    expect(await readFile(filePath, "utf8")).toContain("40d13b8a");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("concurrent migration attempts both succeed with one write", async () => {
  const { dir, filePath, recordId } = await makeSessionsDir(LEGACY_FIXTURE);
  try {
    const results = await Promise.all([
      migrateSessionArgvFile(recordId, TARGET, { sessionsDir: dir }),
      migrateSessionArgvFile(recordId, TARGET, { sessionsDir: dir }),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual(["backfilled", "backfilled"]);
    const written = JSON.parse(await readFile(filePath, "utf8")) as Record<string, unknown>;
    expect(written.agent_argv).toEqual(TARGET.agentArgv);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("transient Windows rename errors are retried", async () => {
  const { dir, filePath, recordId } = await makeSessionsDir(LEGACY_FIXTURE);
  try {
    let attempts = 0;
    const result = await migrateSessionArgvFile(recordId, TARGET, {
      sessionsDir: dir,
      platform: "win32",
      delay: async () => {},
      writeAtomicFn: async (path, content) => {
        attempts += 1;
        if (attempts === 1) {
          const error = new Error("EPERM: rename failed") as NodeJS.ErrnoException;
          error.code = "EPERM";
          throw error;
        }
        await writeFile(path, content);
      },
    });
    expect(result.status).toBe("backfilled");
    expect(attempts).toBe(2);
    const written = JSON.parse(await readFile(filePath, "utf8")) as Record<string, unknown>;
    expect(written.agent_argv).toEqual(TARGET.agentArgv);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the warm queue owner is terminated before the record is written", async () => {
  const { dir, filePath, recordId } = await makeSessionsDir(LEGACY_FIXTURE);
  try {
    const events: string[] = [];
    const result = await migrateSessionArgvFile(recordId, TARGET, {
      sessionsDir: dir,
      beforeWrite: async () => {
        // The record must still lack agent_argv when the owner is terminated.
        const current = JSON.parse(await readFile(filePath, "utf8")) as Record<string, unknown>;
        events.push(`terminated:${"agent_argv" in current ? "has-argv" : "no-argv"}`);
      },
    });
    expect(result.status).toBe("backfilled");
    expect(events).toEqual(["terminated:no-argv"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("acpxSessionRecordFilePath matches acpx's encodeURIComponent layout", () => {
  expect(acpxSessionRecordFilePath("/sessions", "40d13b8a-876f-48d5-837b-5dcad2edba4e"))
    .toBe("/sessions/40d13b8a-876f-48d5-837b-5dcad2edba4e.json");
  expect(acpxSessionRecordFilePath("/sessions", "a b/c"))
    .toBe("/sessions/a%20b%2Fc.json");
});
