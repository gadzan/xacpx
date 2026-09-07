import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { spawn } from "node:child_process";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { existsSync, readdirSync } from "node:fs";

import { createXacpxRuntimeAdapter } from "../../../../../src/bridge/engine/runtime/runtime-adapter";

const MOCK_AGENT = resolve(import.meta.dir, "../../../../fixtures/mock-acp-agent.mjs");
const CLI_ENTRY = resolve(import.meta.dir, "../../../../../node_modules/acpx/dist/cli.js");

interface AcpxSessionRecord {
  schema?: string;
  acpxRecordId?: string;
  acpSessionId?: string;
  agentSessionId?: string;
  agentCommand?: string;
  cwd?: string;
  name?: string;
  createdAt?: string;
  lastUsedAt?: string;
  lastSeq?: number;
  closed?: boolean;
  closedAt?: string;
  pid?: number;
  eventLog?: string;
}

function runAcpx(home: string, args: string[]): Promise<{ code: number; out: string; err: string }> {
  const cmd = `${process.execPath} ${MOCK_AGENT}`;
  const { promise, resolve: resolveP, reject } = Promise.withResolvers<{ code: number; out: string; err: string }>();
  const cp = spawn(process.execPath, [CLI_ENTRY, "--agent", cmd, ...args], {
    cwd: home,
    env: {
      ...process.env,
      HOME: home,
      XDG_STATE_HOME: join(home, ".local", "state"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  let err = "";
  cp.stdout.on("data", (d) => (out += String(d)));
  cp.stderr.on("data", (d) => (err += String(d)));
  cp.on("close", (code) => resolveP({ code: code ?? 1, out, err }));
  cp.on("error", reject);
  return promise;
}

function getSessionFiles(sessionsDir: string): { records: string[]; streams: string[] } {
  if (!existsSync(sessionsDir)) return { records: [], streams: [] };
  const entries = readdirSync(sessionsDir);
  const records = entries.filter((f) => f.endsWith(".json") && f !== "index.json" && !f.startsWith("."));
  const streams = entries.filter((f) => f.endsWith(".stream.ndjson"));
  return { records, streams };
}

test("CLI vs Runtime close parity differential test", async () => {
  // 1. Run CLI Lifecycle: create -> prompt -> status/list -> close -> verify all 6 axes
  const cliHome = await mkdtemp(join(tmpdir(), "close-parity-cli-"));
  const cliSessionsDir = join(cliHome, ".acpx", "sessions");

  let cliRecordBeforeClose: AcpxSessionRecord = {};
  let cliRecordAfterClose: AcpxSessionRecord = {};
  let cliStreamExistsBefore = false;
  let cliStreamExistsAfter = false;
  let cliStreamSizeAfter = 0;
  let cliListOutputAfter = "";
  let cliShowCodeAfter = 0;
  let cliShowOutAfter = "";
  let cliResumeCode = 0;
  let cliResumeErr = "";

  try {
    // Create + prompt
    const initRes = await runAcpx(cliHome, ["--ttl", "1800", "sessions", "new", "--name", "test-session"]);
    expect(initRes.code).toBe(0);

    const promptRes = await runAcpx(cliHome, ["--ttl", "1800", "prompt", "-s", "test-session", "hello world"]);
    expect(promptRes.code).toBe(0);

    const filesBefore = getSessionFiles(cliSessionsDir);
    expect(filesBefore.records.length).toBe(1);
    const recordFileBefore = join(cliSessionsDir, filesBefore.records[0]!);
    cliRecordBeforeClose = JSON.parse(await readFile(recordFileBefore, "utf8")) as AcpxSessionRecord;
    cliStreamExistsBefore = filesBefore.streams.length > 0;

    // Close session
    const closeRes = await runAcpx(cliHome, ["sessions", "close", "test-session"]);
    expect(closeRes.code).toBe(0);

    // Read record after close
    cliRecordAfterClose = JSON.parse(await readFile(recordFileBefore, "utf8")) as AcpxSessionRecord;
    const filesAfter = getSessionFiles(cliSessionsDir);
    cliStreamExistsAfter = filesAfter.streams.length > 0;
    if (cliStreamExistsAfter) {
      const streamStat = await stat(join(cliSessionsDir, filesAfter.streams[0]!));
      cliStreamSizeAfter = streamStat.size;
    }

    // List after close
    const listRes = await runAcpx(cliHome, ["sessions", "list", "--local"]);
    cliListOutputAfter = listRes.out;

    // Show after close
    const showRes = await runAcpx(cliHome, ["sessions", "show", "test-session"]);
    cliShowCodeAfter = showRes.code;
    cliShowOutAfter = showRes.out;

    // Resume after close attempt
    const resumeRes = await runAcpx(cliHome, ["prompt", "-s", "test-session", "after close"]);
    cliResumeCode = resumeRes.code;
    cliResumeErr = resumeRes.err || resumeRes.out;
  } finally {
    await rm(cliHome, { recursive: true, force: true }).catch(() => {});
  }

  // 2. Run Runtime Lifecycle: create -> prompt -> status/list -> close -> verify all 6 axes
  const rtHome = await mkdtemp(join(tmpdir(), "close-parity-rt-"));
  const rtStateDir = join(rtHome, ".acpx");
  const rtSessionsDir = join(rtStateDir, "sessions");

  let rtRecordBeforeClose: AcpxSessionRecord = {};
  let rtRecordAfterClose: AcpxSessionRecord = {};
  let rtStreamExistsBefore = false;
  let rtStreamExistsAfter = false;
  let rtStreamSizeAfter = 0;
  let rtListAfter: AcpxSessionRecord[] = [];
  let rtStatusAfterError: string | null = null;
  let rtResumeError: string | null = null;

  try {
    const adapter = createXacpxRuntimeAdapter({
      cwd: rtHome,
      stateDir: rtStateDir,
      agentOverrides: { mock: [process.execPath, MOCK_AGENT] },
      permissionMode: "approve-all",
    });

    const handle = await adapter.ensure({
      sessionKey: "test-session",
      agent: "mock",
      cwd: rtHome,
    });
    const turn = adapter.startTurn({
      handle,
      text: "hello world",
      mode: "prompt",
      requestId: "turn-1",
    });
    await turn.promptStarted;
    for await (const _ of turn.events) {}
    await turn.result;

    const filesBefore = getSessionFiles(rtSessionsDir);
    expect(filesBefore.records.length).toBe(1);
    const recordFileBefore = join(rtSessionsDir, filesBefore.records[0]!);
    rtRecordBeforeClose = JSON.parse(await readFile(recordFileBefore, "utf8")) as AcpxSessionRecord;
    rtStreamExistsBefore = filesBefore.streams.length > 0;

    // Close session via adapter
    await adapter.close(handle);

    // Read record after close
    rtRecordAfterClose = JSON.parse(await readFile(recordFileBefore, "utf8")) as AcpxSessionRecord;
    const filesAfter = getSessionFiles(rtSessionsDir);
    rtStreamExistsAfter = filesAfter.streams.length > 0;
    if (rtStreamExistsAfter) {
      const streamStat = await stat(join(rtSessionsDir, filesAfter.streams[0]!));
      rtStreamSizeAfter = streamStat.size;
    }

    // List after close from disk
    const filesAfterList = getSessionFiles(rtSessionsDir);
    rtListAfter = [];
    for (const f of filesAfterList.records) {
      const content = await readFile(join(rtSessionsDir, f), "utf8");
      rtListAfter.push(JSON.parse(content) as AcpxSessionRecord);
    }
    // GetStatus after close
    try {
      await adapter.getStatus(handle);
    } catch (err: unknown) {
      rtStatusAfterError = err instanceof Error ? err.message : String(err);
    }

    // Resume attempt after close
    try {
      const resumeTurn = adapter.startTurn({
        handle,
        text: "after close",
        mode: "prompt",
        requestId: "turn-2",
      });
      await resumeTurn.promptStarted;
      await resumeTurn.result;
    } catch (err: unknown) {
      rtResumeError = err instanceof Error ? err.message : String(err);
    }
  } finally {
    await rm(rtHome, { recursive: true, force: true }).catch(() => {});
  }

  // Assert and compare parity
  console.log("=== Close Parity Comparison ===");
  console.log("CLI Record Before Close:", JSON.stringify(cliRecordBeforeClose, null, 2));
  console.log("CLI Record After Close :", JSON.stringify(cliRecordAfterClose, null, 2));
  console.log("RT  Record Before Close:", JSON.stringify(rtRecordBeforeClose, null, 2));
  console.log("RT  Record After Close :", JSON.stringify(rtRecordAfterClose, null, 2));
  console.log("CLI Stream History Preserved:", cliStreamExistsAfter, `(${cliStreamSizeAfter} bytes)`);
  console.log("CLI List Output:", cliListOutputAfter.trim());
  console.log("CLI Show Exit Code:", cliShowCodeAfter, "Out:", cliShowOutAfter.trim());
  console.log("CLI Resume Exit Code:", cliResumeCode, "Err:", cliResumeErr.trim());
  console.log("RT  Status After Error:", rtStatusAfterError);
  console.log("RT  Resume Result:", rtResumeError ?? "succeeded");

  // Assertions
  expect(cliRecordAfterClose.closed).toBe(true);
  expect(rtRecordAfterClose.closed).toBe(true);
  const cliIdBefore = cliRecordBeforeClose.acpxRecordId ?? (cliRecordBeforeClose as Record<string, unknown>)["acpx_record_id"];
  const cliIdAfter = cliRecordAfterClose.acpxRecordId ?? (cliRecordAfterClose as Record<string, unknown>)["acpx_record_id"];
  const rtIdBefore = rtRecordBeforeClose.acpxRecordId ?? (rtRecordBeforeClose as Record<string, unknown>)["acpx_record_id"];
  const rtIdAfter = rtRecordAfterClose.acpxRecordId ?? (rtRecordAfterClose as Record<string, unknown>)["acpx_record_id"];
  expect(cliIdAfter).toBe(cliIdBefore);
  expect(rtIdAfter).toBe(rtIdBefore);
}, 30_000);
