import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  symlinkSync,
  rmSync,
} from "node:fs";
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
    await expect(fs.readFile("ws", "/etc/passwd")).rejects.toThrow(
      "path-must-be-relative",
    );
  });

  test("rejects a .. traversal escape", async () => {
    await expect(fs.listDirectory("ws", "../")).rejects.toThrow(
      /escapes-workspace|not-found/,
    );
  });

  test("rejects a symlink that escapes the root", async () => {
    await expect(fs.listDirectory("ws", "escape")).rejects.toThrow(
      "path-escapes-workspace",
    );
    await expect(fs.readFile("ws", "escape/secret.txt")).rejects.toThrow(
      "path-escapes-workspace",
    );
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
    const r = await fs.search("ws", { query: "A.TS" });
    expect(r.matches).toContain("src/a.ts");
    expect(r.truncated).toBe(false);
  });

  test("returns no matches for an empty or unmatched query", async () => {
    expect((await fs.search("ws", { query: "" })).matches).toEqual([]);
    expect((await fs.search("ws", { query: "zzz-nope" })).matches).toEqual([]);
  });

  test("does not follow a symlink that escapes the root", async () => {
    // `escape` points outside; its `secret.txt` must never appear in results.
    const r = await fs.search("ws", { query: "secret" });
    expect(r.matches).toEqual([]);
  });
});

describe("WorkspaceFs search: modes + flags", () => {
  test("name mode: regex + include filter on relative path", async () => {
    const r = await fs.search("ws", {
      query: "\\.ts$",
      mode: "name",
      regex: true,
    });
    expect(r.matches).toContain("src/a.ts");
    expect(r.matches.every((m) => m.endsWith(".ts"))).toBe(true);
    expect(r.hits).toEqual([]);
  });

  test("name mode: exclude glob drops matches", async () => {
    const r = await fs.search("ws", {
      query: "a",
      mode: "name",
      exclude: "src/**",
    });
    expect(r.matches.some((m) => m.startsWith("src/"))).toBe(false);
  });

  test("content mode: finds a line and returns path/line/text", async () => {
    const r = await fs.search("ws", {
      query: "export const a",
      mode: "content",
    });
    const hit = r.hits.find((h) => h.path === "src/a.ts");
    expect(hit).toBeDefined();
    expect(hit!.line).toBe(1);
    expect(hit!.text).toContain("export const a");
    expect(r.matches).toEqual([]);
  });

  test("content mode: case-sensitive miss vs case-insensitive hit", async () => {
    const sensitive = await fs.search("ws", {
      query: "EXPORT",
      mode: "content",
      matchCase: true,
    });
    expect(sensitive.hits.length).toBe(0);
    const insensitive = await fs.search("ws", {
      query: "EXPORT",
      mode: "content",
      matchCase: false,
    });
    expect(insensitive.hits.length).toBeGreaterThan(0);
  });

  test("empty query returns nothing", async () => {
    const r = await fs.search("ws", { query: "   ", mode: "content" });
    expect(r.hits).toEqual([]);
    expect(r.matches).toEqual([]);
  });
});

describe("WorkspaceFs search: content grep in a git repo (include/exclude/path narrowing)", () => {
  let repo: string;
  let rfs: WorkspaceFs;
  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), "wsfs-grep-"));
    execFileSync("git", ["init", "-q"], { cwd: repo });
    execFileSync("git", ["config", "user.email", "t@t"], { cwd: repo });
    execFileSync("git", ["config", "user.name", "t"], { cwd: repo });
    mkdirSync(join(repo, "src"));
    mkdirSync(join(repo, "other"));
    writeFileSync(join(repo, "src", "a.ts"), "const needle = 1;\n");
    writeFileSync(join(repo, "other", "b.ts"), "const needle = 2;\n");
    execFileSync("git", ["add", "-A"], { cwd: repo }); // tracked; --untracked also covers unadded files
    rfs = new WorkspaceFs(() => [{ name: "g", cwd: repo }]);
  });
  afterAll(() => rmSync(repo, { recursive: true, force: true }));

  test("finds hits across both files with no scoping", async () => {
    const r = await rfs.search("g", { query: "needle", mode: "content" });
    expect(r.hits.map((h) => h.path).sort()).toEqual([
      "other/b.ts",
      "src/a.ts",
    ]);
  });

  test("include narrows to matching files only (no leak from outside the glob)", async () => {
    const r = await rfs.search("g", {
      query: "needle",
      mode: "content",
      include: "src/**",
    });
    expect(r.hits.map((h) => h.path)).toEqual(["src/a.ts"]);
  });

  test("path scopes the search (no leak from outside the base dir)", async () => {
    const r = await rfs.search("g", {
      query: "needle",
      mode: "content",
      path: "src",
    });
    expect(r.hits.map((h) => h.path)).toEqual(["src/a.ts"]);
  });

  test("exclude drops matching files", async () => {
    const r = await rfs.search("g", {
      query: "needle",
      mode: "content",
      exclude: "other/**",
    });
    expect(r.hits.some((h) => h.path === "other/b.ts")).toBe(false);
    expect(r.hits.some((h) => h.path === "src/a.ts")).toBe(true);
  });

  test("path containment still applies to search scoping", async () => {
    await expect(
      rfs.search("g", { query: "x", mode: "content", path: "../.." }),
    ).rejects.toThrow(/escapes-workspace|not-found/);
  });
});

describe("WorkspaceFs git diff", () => {
  test("throws on a non-git workspace", async () => {
    await expect(fs.gitDiff("ws")).rejects.toThrow("not-a-git-repo");
  });

  test("reports changed files and a unified diff", async () => {
    const repo = mkdtempSync(join(tmpdir(), "wsfs-git-"));
    const git = (...args: string[]) =>
      execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });
    git("init", "-q");
    git("config", "user.email", "t@t");
    git("config", "user.name", "t");
    writeFileSync(join(repo, "f.txt"), "one\n");
    git("add", ".");
    git("commit", "-qm", "init");
    writeFileSync(join(repo, "f.txt"), "one\ntwo\n"); // modify
    writeFileSync(join(repo, "new.txt"), "fresh\n"); // untracked
    const gfs = new WorkspaceFs(() => [{ name: "g", cwd: repo }]);
    const d = await gfs.gitDiff("g");
    expect(d.files.map((f) => f.path)).toContain("f.txt");
    expect(
      d.files.some((f) => f.path === "new.txt" && f.status.includes("?")),
    ).toBe(true);
    expect(d.diff).toContain("+two");
    rmSync(repo, { recursive: true, force: true });
  });

  test("reports the branch and the (primary) worktree context", async () => {
    const repo = mkdtempSync(join(tmpdir(), "wsfs-git-"));
    const git = (...args: string[]) =>
      execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });
    git("init", "-q", "-b", "trunk");
    git("config", "user.email", "t@t");
    git("config", "user.name", "t");
    writeFileSync(join(repo, "f.txt"), "one\n");
    git("add", ".");
    git("commit", "-qm", "init");
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
    const git = (...args: string[]) =>
      execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });
    git("init", "-q");
    git("config", "user.email", "t@t");
    git("config", "user.name", "t");
    writeFileSync(join(repo, "f.txt"), "one\n");
    git("add", ".");
    git("commit", "-qm", "init");
    git("checkout", "-q", "--detach", "HEAD");
    const gfs = new WorkspaceFs(() => [{ name: "g", cwd: repo }]);
    const d = await gfs.gitDiff("g");
    expect(d.detached).toBe(true);
    expect(d.branch).toBeUndefined();
    rmSync(repo, { recursive: true, force: true });
  });

  test("marks a linked worktree", async () => {
    const repo = mkdtempSync(join(tmpdir(), "wsfs-git-"));
    const git = (...args: string[]) =>
      execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });
    git("init", "-q", "-b", "main");
    git("config", "user.email", "t@t");
    git("config", "user.name", "t");
    writeFileSync(join(repo, "f.txt"), "one\n");
    git("add", ".");
    git("commit", "-qm", "init");
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
    const git = (...args: string[]) =>
      execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });
    git("init", "-q");
    git("config", "user.email", "t@t");
    git("config", "user.name", "t");
    writeFileSync(join(repo, "首页.txt"), "hi\n"); // untracked, non-ASCII name
    const gfs = new WorkspaceFs(() => [{ name: "g", cwd: repo }]);
    const d = await gfs.gitDiff("g");
    expect(
      d.files.some((f) => f.path === "首页.txt" && f.status.includes("?")),
    ).toBe(true);
    // The old plain --porcelain would have produced an octal-escaped, quoted path.
    expect(d.files.every((f) => !f.path.includes("\\"))).toBe(true);
    rmSync(repo, { recursive: true, force: true });
  });

  test("lists only the new path for a staged rename", async () => {
    const repo = mkdtempSync(join(tmpdir(), "wsfs-git-"));
    const git = (...args: string[]) =>
      execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });
    git("init", "-q");
    git("config", "user.email", "t@t");
    git("config", "user.name", "t");
    writeFileSync(join(repo, "old.txt"), "one\n");
    git("add", ".");
    git("commit", "-qm", "init");
    git("mv", "old.txt", "新名.txt");
    const gfs = new WorkspaceFs(() => [{ name: "g", cwd: repo }]);
    const d = await gfs.gitDiff("g");
    expect(
      d.files.some((f) => f.path === "新名.txt" && f.status[0] === "R"),
    ).toBe(true);
    expect(d.files.some((f) => f.path === "old.txt")).toBe(false); // original path is consumed, not listed
    rmSync(repo, { recursive: true, force: true });
  });

  test("expands an untracked directory into individual files instead of a collapsed dir", async () => {
    const repo = mkdtempSync(join(tmpdir(), "wsfs-git-"));
    const git = (...args: string[]) =>
      execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });
    git("init", "-q");
    git("config", "user.email", "t@t");
    git("config", "user.name", "t");
    writeFileSync(join(repo, "seed.txt"), "x\n");
    git("add", ".");
    git("commit", "-qm", "init");
    mkdirSync(join(repo, "sub"));
    writeFileSync(join(repo, "sub", "a.txt"), "a\n");
    writeFileSync(join(repo, "sub", "b.txt"), "b\n");
    const gfs = new WorkspaceFs(() => [{ name: "g", cwd: repo }]);
    const d = await gfs.gitDiff("g");
    const paths = d.files.map((f) => f.path);
    expect(paths).toContain("sub/a.txt");
    expect(paths).toContain("sub/b.txt");
    expect(paths).not.toContain("sub/"); // plain --porcelain would collapse to the dir
    rmSync(repo, { recursive: true, force: true });
  });

  test("synthesizes an all-additions diff for an untracked file", async () => {
    const repo = mkdtempSync(join(tmpdir(), "wsfs-git-"));
    const git = (...args: string[]) =>
      execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });
    git("init", "-q");
    git("config", "user.email", "t@t");
    git("config", "user.name", "t");
    writeFileSync(join(repo, "seed.txt"), "x\n");
    git("add", ".");
    git("commit", "-qm", "init");
    writeFileSync(join(repo, "untracked.txt"), "alpha\nbeta\n"); // never added
    const gfs = new WorkspaceFs(() => [{ name: "g", cwd: repo }]);
    const d = await gfs.gitDiff("g", "untracked.txt");
    expect(d.diff).toContain("+alpha");
    expect(d.diff).toContain("+beta");
    rmSync(repo, { recursive: true, force: true });
  });
});

describe("WorkspaceFs listing: ignored flag + root/sep", () => {
  let gitRoot: string;
  let gfs: WorkspaceFs;
  beforeAll(() => {
    gitRoot = mkdtempSync(join(tmpdir(), "wsfs-git-"));
    execFileSync("git", ["init", "-q"], { cwd: gitRoot });
    execFileSync("git", ["config", "user.email", "t@t"], { cwd: gitRoot });
    execFileSync("git", ["config", "user.name", "t"], { cwd: gitRoot });
    writeFileSync(join(gitRoot, ".gitignore"), "ignored.log\ndist/\n");
    writeFileSync(join(gitRoot, "keep.ts"), "export const x = 1;\n");
    writeFileSync(join(gitRoot, "ignored.log"), "noise\n");
    mkdirSync(join(gitRoot, "dist"));
    writeFileSync(join(gitRoot, "dist", "out.js"), "1\n");
    gfs = new WorkspaceFs(() => [{ name: "g", cwd: gitRoot }]);
  });
  afterAll(() => rmSync(gitRoot, { recursive: true, force: true }));

  test("marks gitignored entries and returns absolute root + sep", async () => {
    const r = await gfs.listDirectory("g", "");
    const byName = Object.fromEntries(r.entries.map((e) => [e.name, e]));
    expect(byName["ignored.log"].ignored).toBe(true);
    expect(byName["dist"].ignored).toBe(true);
    expect(byName["keep.ts"].ignored).toBeUndefined();
    expect(r.root).toBe(require("node:fs").realpathSync(gitRoot));
    expect(r.sep).toBe(require("node:path").sep);
  });

  test("non-git workspace lists without ignored flags and still returns root/sep", async () => {
    const r = await fs.listDirectory("ws", "");
    expect(r.entries.every((e) => e.ignored === undefined)).toBe(true);
    expect(typeof r.root).toBe("string");
    expect(r.sep).toBe(require("node:path").sep);
  });
});
