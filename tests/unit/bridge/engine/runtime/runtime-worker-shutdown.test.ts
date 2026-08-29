import { expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const WORKER_MAIN = join(import.meta.dir, "../../../../../src/bridge/engine/runtime/runtime-worker-main.ts");

test("static guard: shutdown ACK arms NO bare-exit timer (round 29 Blocking 2)", async () => {
  // The old fallback `setTimeout(() => process.exit(0), 10_000)` could cut a
  // >10s Windows EOF convergence mid-transaction. The only allowed
  // process.exit sites are the post-convergence exit and nothing else.
  const source = await readFile(WORKER_MAIN, "utf8");
  expect(source).not.toContain("10_000");
  expect(source).not.toContain("fallbackTimer");
  const codeLines = source.split("\n").filter((line) => !line.trim().startsWith("//"));
  const exits = codeLines.join("\n").match(/process\.exit\(/g) ?? [];
  // Exactly one: the exit AFTER convergeOrphansBeforeExit settles.
  expect(exits.length).toBe(1);
  expect(source).toMatch(/convergeOrphansBeforeExit[\s\S]*?process\.exit\(0\)/);
});

test("shutdown ACK: worker does NOT self-exit; it exits only via stdin-EOF convergence", async () => {
  // Real worker process (bun runs the TS entry natively). Real timers are the
  // behavior under test: the old code force-exited ~10s after the ACK.
  const child: ChildProcess = spawn(process.execPath, [WORKER_MAIN], {
    stdio: ["pipe", "pipe", "pipe"],
    // Detached = the worker is its own POSIX group leader — the same
    // production spawn contract that stdin-EOF group-kill convergence
    // relies on. Without it the self-group kill finds no group (ESRCH).
    detached: process.platform !== "win32",
    windowsHide: true,
  });
  const ackLines: string[] = [];
  const errorLines: string[] = [];
  let buffer = "";
  child.stdout!.on("data", (chunk: Buffer) => {
    buffer += chunk.toString();
    let idx: number;
    while ((idx = buffer.indexOf("\n")) >= 0) {
      const frame = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      ackLines.push(frame);
      if (frame.includes('"ok":false')) errorLines.push(frame);
    }
  });
  try {
    child.stdin!.write(`${JSON.stringify({ id: "s1", method: "shutdown" })}\n`);
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline && !ackLines.some((line) => line.includes('"s1"'))) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(ackLines.some((line) => line.includes('"ok":true') && line.includes('"s1"'))).toBe(true);
    // OLD behavior: process.exit(0) fires here (10s fallback timer). NEW
    // behavior: the worker must still be alive with stdin held open.
    await new Promise((resolve) => setTimeout(resolve, 10_500));
    expect(child.exitCode).toBeNull();
    expect(ackLines.some((line) => line.includes('"ok":true') && line.includes('"s1"'))).toBe(true);
    // Round 30 Medium: exactly ONE response for the shutdown request — the
    // old fall-through emitted a second "unsupported" error frame.
    expect(ackLines.filter((line) => line.includes('"s1"'))).toHaveLength(1);
    // Admission is closed: a late business RPC gets exactly one stable
    // RUNTIME_WORKER_TEARDOWN_PENDING error — never a silent success, never
    // an entry into the quiescing worker.
    child.stdin!.write(`${JSON.stringify({ id: "late-1", method: "ensure", params: {} })}\n`);
    const lateDeadline = Date.now() + 3_000;
    while (Date.now() < lateDeadline && errorLines.length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(errorLines).toHaveLength(1);
    expect(errorLines[0]).toContain("RUNTIME_WORKER_TEARDOWN_PENDING");
    expect(errorLines[0]).toContain('"late-1"');
    // Now the host "dies": stdin EOF → convergence → clean exit.
    child.stdin!.end();
    const exitCode = await Promise.race([
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("worker did not exit after EOF")), 20_000).unref()),
      new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code))),
    ]);
    expect(exitCode === 0 || exitCode === null).toBe(true);
  } finally {
    try { child.stdin?.end(); } catch {}
    try { child.kill("SIGKILL"); } catch {}
  }
}, 40_000);
