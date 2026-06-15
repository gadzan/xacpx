import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceFs } from "../../../src/control/workspace-fs";

let root: string;
let outside: string;
let fs: WorkspaceFs;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "wsfs-"));
  outside = mkdtempSync(join(tmpdir(), "wsfs-out-"));
  writeFileSync(join(outside, "secret.txt"), "TOP SECRET");
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "README.md"), "# hello\n");
  writeFileSync(join(root, "src", "a.ts"), "export const a = 1;\n");
  writeFileSync(join(root, "bin.dat"), Buffer.from([0x00, 0x01, 0x02, 0x00]));
  symlinkSync(outside, join(root, "escape")); // symlink pointing outside the root
  fs = new WorkspaceFs(() => [{ name: "ws", cwd: root }]);
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

describe("WorkspaceFs containment", () => {
  test("rejects an unknown workspace", async () => {
    await expect(fs.listDirectory("nope")).rejects.toThrow("unknown-workspace");
  });

  test("rejects an absolute path", async () => {
    await expect(fs.readFile("ws", "/etc/passwd")).rejects.toThrow("path-must-be-relative");
  });

  test("rejects a .. traversal escape", async () => {
    await expect(fs.listDirectory("ws", "../")).rejects.toThrow(/escapes-workspace|not-found/);
  });

  test("rejects a symlink that escapes the root", async () => {
    await expect(fs.listDirectory("ws", "escape")).rejects.toThrow("path-escapes-workspace");
    await expect(fs.readFile("ws", "escape/secret.txt")).rejects.toThrow("path-escapes-workspace");
  });
});

describe("WorkspaceFs listing & reading", () => {
  test("lists the root with directories first", async () => {
    const { entries, path } = await fs.listDirectory("ws");
    expect(path).toBe("");
    const names = entries.map((e) => e.name);
    expect(names).toContain("src");
    expect(names).toContain("README.md");
    expect(entries[0].type).toBe("dir"); // dirs sort first
  });

  test("reads a text file", async () => {
    const r = await fs.readFile("ws", "src/a.ts");
    expect(r.content).toContain("export const a = 1");
    expect(r.binary).toBe(false);
    expect(r.truncated).toBe(false);
  });

  test("flags a binary file and omits its content", async () => {
    const r = await fs.readFile("ws", "bin.dat");
    expect(r.binary).toBe(true);
    expect(r.content).toBe("");
  });

  test("expands a leading ~ in the workspace cwd", async () => {
    // HOME is set per test run; point a workspace at "~" and confirm it resolves.
    const home = process.env.HOME ?? "";
    const homeFs = new WorkspaceFs(() => [{ name: "h", cwd: "~" }]);
    const { entries } = await homeFs.listDirectory("h");
    // Resolves to the real home dir without throwing; listing is whatever HOME holds.
    expect(Array.isArray(entries)).toBe(true);
    expect(home.length).toBeGreaterThan(0);
  });
});

describe("WorkspaceFs git diff", () => {
  test("throws on a non-git workspace", async () => {
    await expect(fs.gitDiff("ws")).rejects.toThrow("not-a-git-repo");
  });

  test("reports changed files and a unified diff", async () => {
    const repo = mkdtempSync(join(tmpdir(), "wsfs-git-"));
    const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });
    git("init", "-q");
    git("config", "user.email", "t@t");
    git("config", "user.name", "t");
    writeFileSync(join(repo, "f.txt"), "one\n");
    git("add", "."); git("commit", "-qm", "init");
    writeFileSync(join(repo, "f.txt"), "one\ntwo\n"); // modify
    writeFileSync(join(repo, "new.txt"), "fresh\n"); // untracked
    const gfs = new WorkspaceFs(() => [{ name: "g", cwd: repo }]);
    const d = await gfs.gitDiff("g");
    expect(d.files.map((f) => f.path)).toContain("f.txt");
    expect(d.files.some((f) => f.path === "new.txt" && f.status.includes("?"))).toBe(true);
    expect(d.diff).toContain("+two");
    rmSync(repo, { recursive: true, force: true });
  });
});
