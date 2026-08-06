import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createRuntimeConsumerLock } from "../../src/daemon/runtime-consumer-lock";
import { main } from "../../src/main";

test("app bootstrap exports a runnable entry module", () => {
  expect(typeof main).toBe("function");
});

test("the direct source entry reaches the guarded default runtime without a TLA import deadlock", async () => {
  const root = await mkdtemp(join(tmpdir(), "xacpx-direct-main-"));
  const configPath = join(root, ".xacpx", "config.json");
  const statePath = join(root, ".xacpx", "state.json");
  const lockFilePath = join(root, ".xacpx", "runtime", "runtime-consumer.lock.json");
  await mkdir(join(root, ".xacpx"), { recursive: true });
  await writeFile(configPath, JSON.stringify({
    transport: { type: "acpx-cli", command: "acpx" },
    channel: { type: "weixin" },
    agents: { codex: { driver: "codex" } },
    workspaces: { home: { cwd: root } },
  }));

  const owner = createRuntimeConsumerLock({ lockFilePath });
  await owner.acquire({
    pid: process.pid,
    mode: "daemon",
    startedAt: new Date().toISOString(),
    configPath,
    statePath,
  });

  try {
    const child = spawn("bun", ["run", "./src/main.ts"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: root,
        XACPX_CONFIG: configPath,
        XACPX_STATE: statePath,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => { output += String(chunk); });
    child.stderr.on("data", (chunk) => { output += String(chunk); });
    const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error(`direct main timed out: ${output}`));
      }, 15_000);
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once("close", (code, signal) => {
        clearTimeout(timer);
        resolve({ code, signal });
      });
    });

    expect(result).toEqual({ code: 1, signal: null });
    expect(output).toContain("xacpx runtime is already running");
  } finally {
    await owner.release();
    await rm(root, { recursive: true, force: true });
  }
}, 20_000);
