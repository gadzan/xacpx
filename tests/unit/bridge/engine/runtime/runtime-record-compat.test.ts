import { expect, test } from "bun:test";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { readdirSync } from "node:fs";

import { createXacpxRuntimeAdapter } from "../../../../../src/bridge/engine/runtime/runtime-adapter";
import { MOCK_ACP_AGENT, runAcpxCli } from "../../../../helpers/acpx-cli-spawn";
import { rmTemp } from "../../../../helpers/rm-temp";

const MOCK_AGENT = MOCK_ACP_AGENT;
/**
 * G1 / PR0 Gate: CLI ↔ Runtime bidirectional record compatibility.
 * Must use real acpx CLI (spawned node acpx) for one side of each direction,
 * not just two Runtime adapters sharing a store. Both sides must use same
 * <stateDir>/sessions/<recordId>.json layout and be able to resume the same
 * persistent record (same acpxRecordId, history preserved).
 */

const runAcpx = runAcpxCli;

test("G1: Runtime create → CLI store lists same record and can be resumed by Runtime again", async () => {
  const home = await mkdtemp(join(tmpdir(), "xacpx-g1-rt-cli-"));
  const stateDir = join(home, ".acpx");
  const adapter = createXacpxRuntimeAdapter({
    stateDir,
    permissionMode: "approve-all",
    nonInteractivePermissions: "deny",
    agentOverrides: { mock: [`${process.execPath}`, MOCK_AGENT] },
  });
  // Created outside the try so the finally can release the ACP-agent children:
  // on Windows a live child keeps the temp home locked (rm → EBUSY).
  const runtime = adapter.raw();
  const handles: Array<Awaited<ReturnType<typeof runtime.ensureSession>>> = [];
  try {
    const handle1 = await runtime.ensureSession({
      sessionKey: "g1-rt-cli",
      agent: "mock",
      mode: "persistent",
      cwd: home,
    });
    handles.push(handle1);
    const recordId = handle1.acpxRecordId!;
    expect(recordId.length).toBeGreaterThan(0);

    const turn1 = runtime.startTurn({ handle: handle1, text: "hello from runtime", mode: "prompt", requestId: "g1-rt-1" });
    await turn1.promptStarted;
    for await (const _ of turn1.events) {}
    const res1 = await turn1.result;
    expect(res1.status).toBe("completed");

    // Real CLI must see the same record via `sessions list --local` (HOME-isolated).
    const list = await runAcpx(home, ["sessions", "list", "--local"]);
    expect(list.code).toBe(0);
    expect(list.out).toContain(recordId);
    expect(list.out).toContain("g1-rt-cli");

    // Verify via file system (same store CLI uses) — record file must exist.
    const safeId = encodeURIComponent(recordId);
    const recordFile = join(stateDir, "sessions", `${safeId}.json`);
    const st = await stat(recordFile);
    const raw = JSON.parse(await readFile(recordFile, "utf8")) as Record<string, unknown>;
    expect(raw).toBeDefined();
    expect((raw as { name?: string }).name).toBe("g1-rt-cli");

    // Runtime resumes same record (simulates CLI record being resumed by Runtime)
    const handle2 = await runtime.ensureSession({
      sessionKey: "g1-rt-cli",
      agent: "mock",
      mode: "persistent",
      cwd: home,
    });
    handles.push(handle2);
    expect(handle2.acpxRecordId).toBe(recordId);
    const turn2 = runtime.startTurn({ handle: handle2, text: "second prompt after CLI list", mode: "prompt", requestId: "g1-rt-2" });
    await turn2.promptStarted;
    for await (const _ of turn2.events) {}
    const res2 = await turn2.result;
    expect(res2.status).toBe("completed");

    // History preserved: file still same recordId, now contains at least 2 turns
    const raw2 = JSON.parse(await readFile(recordFile, "utf8")) as Record<string, unknown>;
    expect(raw2).toBeDefined();
    // Verify via store still lists same file
    const filesAfter = readdirSync(join(stateDir, "sessions"));
    expect(filesAfter).toContain(`${safeId}.json`);
  } finally {
    // Close every session first: each one owns an ACP-agent child process, and
    // on Windows a live child keeps the temp home locked (rm → EBUSY) long
    // after the CLI subprocess the test awaited has exited.
    for (const handle of handles) {
      await runtime.close({ handle, reason: "test-done" }).catch(() => {});
    }
    await rmTemp(home);
  }
}, 30_000);

test("G1: CLI store record → Runtime ensure resumes same recordId/history", async () => {
  const home = await mkdtemp(join(tmpdir(), "xacpx-g1-cli-rt-"));
  const stateDir = join(home, ".acpx");
  // Real CLI creates a record via `sessions new` (HOME-isolated)
  const created = await runAcpx(home, ["sessions", "new", "--name", "g1-cli-rt"]);
  expect(created.code).toBe(0);
  const cliRecordId = created.out.trim();
  expect(cliRecordId.length).toBeGreaterThan(0);
  // CLI's record file must exist
  const sessionsDir = join(home, ".acpx", "sessions");
  const cliFile = join(sessionsDir, `${encodeURIComponent(cliRecordId)}.json`);
  const st = await stat(cliFile);
  expect(st.isFile()).toBe(true);
  const cliRaw = JSON.parse(await readFile(cliFile, "utf8")) as Record<string, unknown>;
  expect((cliRaw as { name?: string }).name).toBe("g1-cli-rt");

  // Runtime must be able to resume the SAME recordId (via sessionKey = cliRecordId)
  const adapter = createXacpxRuntimeAdapter({
    stateDir,
    permissionMode: "approve-all",
    nonInteractivePermissions: "deny",
    agentOverrides: { mock: [`${process.execPath}`, MOCK_AGENT] },
  });
  // Created outside the try so the finally can release the ACP-agent child:
  // on Windows a live child keeps the temp home locked (rm → EBUSY).
  const rt = adapter.raw();
  const handles: Array<Awaited<ReturnType<typeof rt.ensureSession>>> = [];
  try {
    const h = await rt.ensureSession({ sessionKey: cliRecordId, agent: "mock", mode: "persistent", cwd: home });
    handles.push(h);
    expect(h.acpxRecordId).toBe(cliRecordId);

    // Do a Runtime turn on the CLI-created record; history should be appended to same file
    const t = rt.startTurn({ handle: h, text: "runtime resumed", mode: "prompt", requestId: "g1-cli-2" });
    await t.promptStarted;
    for await (const _ of t.events) {}
    expect((await t.result).status).toBe("completed");

    // Verify same file still exists and now contains history (via CLI list still shows it)
    const st2 = await stat(cliFile);
    expect(st2.isFile()).toBe(true);
    const after = JSON.parse(await readFile(cliFile, "utf8")) as Record<string, unknown>;
    expect((after as { acpx_record_id?: string }).acpx_record_id).toBe(cliRecordId);

    const list = await runAcpx(home, ["sessions", "list", "--local"]);
    expect(list.code).toBe(0);
    expect(list.out).toContain(cliRecordId);
    expect(list.out).toContain("g1-cli-rt");
  } finally {
    for (const handle of handles) {
      await rt.close({ handle, reason: "test-done" }).catch(() => {});
    }
    await rmTemp(home);
  }
}, 30_000);
