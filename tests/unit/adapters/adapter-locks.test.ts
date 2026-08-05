import { afterEach, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function buildNodeHelper(): Promise<string> {
  const outdir = await mkdtemp(join(process.cwd(), "node_modules", ".adapter-lock-test-"));
  roots.push(outdir);
  const result = await Bun.build({
    entrypoints: [join(process.cwd(), "tests", "helpers", "adapter-lock-child.ts")],
    outdir,
    target: "node",
    external: ["fs-ext"],
  });
  if (!result.success) throw new Error(result.logs.map(String).join("\n"));
  return join(outdir, "adapter-lock-child.js");
}

test("Unix adapter lock keeps a stable file and releases in finally", async () => {
  if (process.platform === "win32") return;
  const runtimeRoot = await mkdtemp(join(tmpdir(), "adapter-flock-"));
  roots.push(runtimeRoot);
  const helper = await buildNodeHelper();
  const run = () => new Promise<void>((resolveRun, reject) => {
    const child = spawn("node", [helper, runtimeRoot, "claude"], { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolveRun() : reject(new Error(stderr)));
  });
  await run();
  const lockPath = join(runtimeRoot, "adapters", ".locks", "adapter-op-claude.lock");
  expect((await stat(lockPath)).isFile()).toBe(true);
  expect(await readFile(lockPath, "utf8")).toBe("");
  await run();
}, 20_000);

test("real flock is exclusive across Node processes and crash-released", async () => {
  if (process.platform === "win32") return;
  const runtimeRoot = await mkdtemp(join(tmpdir(), "adapter-flock-process-"));
  roots.push(runtimeRoot);
  const helper = await buildNodeHelper();
  const start = (mode?: "hold") => spawn("node", [helper, runtimeRoot, "codex", ...(mode ? [mode] : [])], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output = (child: ReturnType<typeof start>, pattern: RegExp) => new Promise<string>((resolveOutput, reject) => {
    let value = "";
    const timer = setTimeout(() => reject(new Error(`timeout: ${value}`)), 10_000);
    child.stdout.on("data", (chunk) => {
      value += String(chunk);
      if (pattern.test(value)) {
        clearTimeout(timer);
        resolveOutput(value);
      }
    });
    child.stderr.on("data", (chunk) => { value += String(chunk); });
    child.once("error", reject);
  });

  const holder = start("hold");
  await output(holder, /ACQUIRED:/);
  const contender = start();
  expect(await output(contender, /BUSY/)).toContain("BUSY");
  holder.kill("SIGKILL");
  await new Promise<void>((resolveClose) => holder.once("close", () => resolveClose()));
  const replacement = start();
  expect(await output(replacement, /ACQUIRED:/)).toContain("ACQUIRED:");
}, 20_000);
