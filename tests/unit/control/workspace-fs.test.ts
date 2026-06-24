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

describe("WorkspaceFs search", () => {
  test("finds files by case-insensitive path substring", async () => {
    const r = await fs.search("ws", "A.TS");
    expect(r.matches).toContain("src/a.ts");
    expect(r.truncated).toBe(false);
  });

  test("returns no matches for an empty or unmatched query", async () => {
    expect((await fs.search("ws", "")).matches).toEqual([]);
    expect((await fs.search("ws", "zzz-nope")).matches).toEqual([]);
  });

  test("does not follow a symlink that escapes the root", async () => {
    // `escape` points outside; its `secret.txt` must never appear in results.
    const r = await fs.search("ws", "secret");
    expect(r.matches).toEqual([]);
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

  test("reports the branch and the (primary) worktree context", async () => {
    const repo = mkdtempSync(join(tmpdir(), "wsfs-git-"));
    const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });
    git("init", "-q", "-b", "trunk");
    git("config", "user.email", "t@t");
    git("config", "user.name", "t");
    writeFileSync(join(repo, "f.txt"), "one\n");
    git("add", "."); git("commit", "-qm", "init");
    const gfs = new WorkspaceFs(() => [{ name: "g", cwd: repo }]);
    const d = await gfs.gitDiff("g");
    expect(d.branch).toBe("trunk");
    expect(d.detached).toBeFalsy();
    expect(d.worktree?.linked).toBe(false);
    // The worktree root resolves to the repo (realpath, so /private prefix on macOS is fine).
    expect(d.worktree?.root.endsWith(repo.split("/").pop()!)).toBe(true);
    rmSync(repo, { recursive: true, force: true });
  });

  test("flags a detached HEAD without a branch name", async () => {
    const repo = mkdtempSync(join(tmpdir(), "wsfs-git-"));
    const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });
    git("init", "-q");
    git("config", "user.email", "t@t");
    git("config", "user.name", "t");
    writeFileSync(join(repo, "f.txt"), "one\n");
    git("add", "."); git("commit", "-qm", "init");
    git("checkout", "-q", "--detach", "HEAD");
    const gfs = new WorkspaceFs(() => [{ name: "g", cwd: repo }]);
    const d = await gfs.gitDiff("g");
    expect(d.detached).toBe(true);
    expect(d.branch).toBeUndefined();
    rmSync(repo, { recursive: true, force: true });
  });

  test("marks a linked worktree", async () => {
    const repo = mkdtempSync(join(tmpdir(), "wsfs-git-"));
    const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });
    git("init", "-q", "-b", "main");
    git("config", "user.email", "t@t");
    git("config", "user.name", "t");
    writeFileSync(join(repo, "f.txt"), "one\n");
    git("add", "."); git("commit", "-qm", "init");
    const wt = join(repo, "..", `wt-${repo.split("/").pop()}`);
    git("worktree", "add", "-q", "-b", "feature", wt);
    const gfs = new WorkspaceFs(() => [{ name: "wt", cwd: wt }]);
    const d = await gfs.gitDiff("wt");
    expect(d.branch).toBe("feature");
    expect(d.worktree?.linked).toBe(true);
    rmSync(repo, { recursive: true, force: true });
    rmSync(wt, { recursive: true, force: true });
  });

  test("returns non-ASCII filenames unescaped (quotePath off + -z)", async () => {
    const repo = mkdtempSync(join(tmpdir(), "wsfs-git-"));
    const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });
    git("init", "-q");
    git("config", "user.email", "t@t");
    git("config", "user.name", "t");
    writeFileSync(join(repo, "首页.txt"), "hi\n"); // untracked, non-ASCII name
    const gfs = new WorkspaceFs(() => [{ name: "g", cwd: repo }]);
    const d = await gfs.gitDiff("g");
    expect(d.files.some((f) => f.path === "首页.txt" && f.status.includes("?"))).toBe(true);
    // The old plain --porcelain would have produced an octal-escaped, quoted path.
    expect(d.files.every((f) => !f.path.includes("\\"))).toBe(true);
    rmSync(repo, { recursive: true, force: true });
  });

  test("lists only the new path for a staged rename", async () => {
    const repo = mkdtempSync(join(tmpdir(), "wsfs-git-"));
    const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });
    git("init", "-q");
    git("config", "user.email", "t@t");
    git("config", "user.name", "t");
    writeFileSync(join(repo, "old.txt"), "one\n");
    git("add", "."); git("commit", "-qm", "init");
    git("mv", "old.txt", "新名.txt");
    const gfs = new WorkspaceFs(() => [{ name: "g", cwd: repo }]);
    const d = await gfs.gitDiff("g");
    expect(d.files.some((f) => f.path === "新名.txt" && f.status[0] === "R")).toBe(true);
    expect(d.files.some((f) => f.path === "old.txt")).toBe(false); // original path is consumed, not listed
    rmSync(repo, { recursive: true, force: true });
  });

  test("synthesizes an all-additions diff for an untracked file", async () => {
    const repo = mkdtempSync(join(tmpdir(), "wsfs-git-"));
    const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });
    git("init", "-q");
    git("config", "user.email", "t@t");
    git("config", "user.name", "t");
    writeFileSync(join(repo, "seed.txt"), "x\n");
    git("add", "."); git("commit", "-qm", "init");
    writeFileSync(join(repo, "untracked.txt"), "alpha\nbeta\n"); // never added
    const gfs = new WorkspaceFs(() => [{ name: "g", cwd: repo }]);
    const d = await gfs.gitDiff("g", "untracked.txt");
    expect(d.diff).toContain("+alpha");
    expect(d.diff).toContain("+beta");
    rmSync(repo, { recursive: true, force: true });
  });
});
