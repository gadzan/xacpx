import { expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { TerminalRegistryLockedError, TerminalRegistryStore } from "../../../../packages/channel-relay/src/terminal/terminal-registry-store";

function startWriter(helper: string, dir: string) {
  const child = spawn("node", [helper, dir], {
    cwd: process.cwd(),
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  const ready = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`registry writer timed out: ${stdout}\n${stderr}`)), 10_000);
    const finish = (error?: Error) => {
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
      if (stdout.includes("ACQUIRED\n")) finish();
      else if (stdout.includes("BUSY\n")) finish(new Error("child registry writer was unexpectedly busy"));
    });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.once("error", (error) => finish(error));
    child.once("close", (code) => finish(new Error(`registry writer exited ${code}: ${stdout}\n${stderr}`)));
  });
  return { child, closed, ready };
}

async function killChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const closed = once(child, "close");
  child.kill("SIGKILL");
  await closed;
}

test("a live registry writer survives stale mtime and a crashed writer releases ownership", { timeout: 20_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "term-registry-recovery-"));
  const helperDir = await mkdtemp(join(process.cwd(), "node_modules", ".registry-lock-test-"));
  const helper = join(helperDir, "writer.js");
  const build = await Bun.build({
    entrypoints: ["tests/helpers/terminal-registry-lock-child.ts"], target: "node",
    external: ["fs-ext"], outdir: helperDir, naming: "writer.js",
  });
  if (!build.success) throw new AggregateError(build.logs, "registry helper build failed");
  const holder = startWriter(helper, dir);
  const contender = new TerminalRegistryStore({ dir, exclusiveWriter: true });
  try {
    await holder.ready;
    const past = new Date(Date.now() - 60_000);
    await utimes(join(dir, "terminals.lock"), past, past);
    await expect(contender.load()).rejects.toBeInstanceOf(TerminalRegistryLockedError);

    const closed = holder.closed;
    holder.child.kill("SIGKILL");
    await closed;
    await contender.load();
    await contender.upsertCreating({
      terminalId: "recovered", logicalSessionId: "session", internalAliasSnapshot: "alias",
      rmuxSessionName: "rmux-recovered", generation: "recovered-generation",
    });
    await contender.close();
    const reopened = await contender.load();
    expect(reopened.terminals.recovered?.generation).toBe("recovered-generation");
  } finally {
    await contender.close();
    await killChild(holder.child);
    await rm(dir, { recursive: true, force: true });
    await rm(helperDir, { recursive: true, force: true });
  }
});
