import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, realpath, rm, symlink } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildIpcGuardPipeName,
  canonicalizeIpcGuardConfigRoot,
  normalizeCanonicalIpcPath,
} from "../../../src/process/ipc-guard";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("normalizes Windows case, separators, and trailing separators", () => {
  expect(normalizeCanonicalIpcPath("C:\\Users\\Me\\Xacpx\\", "win32"))
    .toBe("c:/users/me/xacpx");
  expect(normalizeCanonicalIpcPath("C:/", "win32")).toBe("c:/");
});

test("creates an owned config root before canonicalizing it", async () => {
  const parent = await mkdtemp(join(tmpdir(), "ipc-guard-create-"));
  roots.push(parent);
  const configRoot = join(parent, "missing", "config");
  expect(await canonicalizeIpcGuardConfigRoot(configRoot)).toBe(normalizeCanonicalIpcPath(await realpath(configRoot)));
});

test("read-only canonicalization resolves a missing leaf through the nearest existing real ancestor", async () => {
  const parent = await mkdtemp(join(tmpdir(), "ipc-guard-link-"));
  roots.push(parent);
  const actual = join(parent, "actual");
  const alias = join(parent, "alias");
  await mkdir(actual);
  await symlink(actual, alias, process.platform === "win32" ? "junction" : "dir");
  const missingViaAlias = join(alias, "not-created", "config");
  const missingViaReal = join(actual, "not-created", "config");
  expect(await canonicalizeIpcGuardConfigRoot(missingViaAlias, { createConfigRoot: false }))
    .toBe(await canonicalizeIpcGuardConfigRoot(missingViaReal, { createConfigRoot: false }));
});

test("equivalent config-root spellings produce the same guard pipe name", async () => {
  const root = await mkdtemp(join(tmpdir(), "ipc-guard-key-"));
  roots.push(root);
  const withSlash = `${root}/`;
  const key = { role: "adapter-op", resourceId: "claude", configRoot: root };
  const equivalent = { ...key, configRoot: withSlash };
  expect(await buildIpcGuardPipeName(key, { platform: "win32" }))
    .toBe(await buildIpcGuardPipeName(equivalent, { platform: "win32" }));
});

test("a non-ENOENT realpath failure fails closed", async () => {
  const denied = Object.assign(new Error("denied"), { code: "EACCES" });
  await expect(canonicalizeIpcGuardConfigRoot("/unreadable/config", {
    createConfigRoot: false,
    fileSystem: {
      mkdir,
      realpath: async () => { throw denied; },
    },
  })).rejects.toBe(denied);
});

test("role and resource id are part of the structured guard key", async () => {
  const root = await mkdtemp(join(tmpdir(), "ipc-guard-roles-"));
  roots.push(root);
  const consumer = await buildIpcGuardPipeName({ role: "consumer", configRoot: root });
  const claude = await buildIpcGuardPipeName({ role: "adapter-op", resourceId: "claude", configRoot: root });
  const codex = await buildIpcGuardPipeName({ role: "adapter-op", resourceId: "codex", configRoot: root });
  expect(new Set([consumer, claude, codex]).size).toBe(3);
  expect(consumer).toMatch(/^\\\\\.\\pipe\\xacpx-[0-9a-f]{16}$/);
});

const windowsTest = process.platform === "win32" ? test : test.skip;

windowsTest("real Windows guard is exclusive across processes and crash-released", { timeout: 20_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "ipc-guard-process-"));
  roots.push(root);
  const helper = join(process.cwd(), "tests", "helpers", "ipc-guard-child.ts");
  const spawnHelper = (hold?: boolean) => spawn("node", ["--import", "tsx", helper, root, ...(hold ? ["hold"] : [])], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const waitForOutput = (child: ReturnType<typeof spawn>, expected: RegExp) => new Promise<string>((resolveOutput, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${expected}: ${output}`)), 10_000);
    child.stdout?.on("data", (chunk) => {
      output += String(chunk);
      if (expected.test(output)) {
        clearTimeout(timer);
        resolveOutput(output);
      }
    });
    child.stderr?.on("data", (chunk) => { output += String(chunk); });
    child.once("error", reject);
  });

  const holder = spawnHelper(true);
  await waitForOutput(holder, /ACQUIRED:/);
  const contender = spawnHelper();
  expect(await waitForOutput(contender, /BUSY/)).toContain("BUSY");
  holder.kill("SIGKILL");
  await new Promise<void>((resolveClose) => holder.once("close", () => resolveClose()));
  const replacement = spawnHelper();
  expect(await waitForOutput(replacement, /ACQUIRED:/)).toContain("ACQUIRED:");
});
