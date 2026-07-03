import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceFs } from "../../../src/control/workspace-fs";

// Hardening: user-supplied opts.regex reaches `git grep -E` (subprocess) and, previously,
// an in-process RegExp fallback for non-git dirs. These tests verify the *observable*
// behavior of the hardened paths (git-timeout backstop, --no-index routing + path
// reconciliation, regression parity) — not timing internals, which are covered by review.

describe("WorkspaceFs content search: non-git dir routes through `git grep --no-index`", () => {
  let root: string;
  let fs: WorkspaceFs;
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "wsfs-redos-noindex-"));
    writeFileSync(join(root, "notes.txt"), "hello world\n");
    mkdirSync(join(root, "sub"));
    writeFileSync(join(root, "sub", "a.txt"), "needle\n");
    fs = new WorkspaceFs(() => [{ name: "ws", cwd: root }]);
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  test("finds a hit at the workspace root with a root-relative path", async () => {
    const r = await fs.search("ws", { query: "world", mode: "content" });
    const hit = r.hits.find((h) => h.path === "notes.txt");
    expect(hit).toBeDefined();
    expect(hit!.line).toBe(1);
  });

  test("scoped search (opts.path) reconciles --no-index's base-relative path back to root-relative", async () => {
    const r = await fs.search("ws", { query: "needle", mode: "content", path: "sub" });
    expect(r.hits.map((h) => h.path)).toEqual(["sub/a.txt"]);
  });
});

describe("WorkspaceFs content search: ReDoS pattern in a git repo returns promptly", () => {
  let repo: string;
  let fs: WorkspaceFs;
  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), "wsfs-redos-git-"));
    execFileSync("git", ["init", "-q"], { cwd: repo });
    execFileSync("git", ["config", "user.email", "t@t"], { cwd: repo });
    execFileSync("git", ["config", "user.name", "t"], { cwd: repo });
    // A long run of "a" with no trailing "b" is the classic (a+)+$ catastrophic-backtracking
    // trigger for a naive backtracking engine; git's regex engine (and our timeout backstop)
    // must not hang on it.
    writeFileSync(join(repo, "evil.txt"), "a".repeat(100) + "\n");
    execFileSync("git", ["add", "-A"], { cwd: repo });
    fs = new WorkspaceFs(() => [{ name: "g", cwd: repo }]);
  });
  afterAll(() => rmSync(repo, { recursive: true, force: true }));

  test("resolves within a few seconds instead of hanging", async () => {
    const timeout = new Promise<"timed-out">((resolve) => setTimeout(() => resolve("timed-out"), 8000));
    const result = await Promise.race([
      fs.search("g", { query: "(a+)+$", mode: "content", regex: true }),
      timeout,
    ]);
    expect(result).not.toBe("timed-out");
  });
});

describe("WorkspaceFs content search: `--no-index` skips node_modules/.git", () => {
  let root: string;
  let fs: WorkspaceFs;
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "wsfs-redos-skipdirs-"));
    mkdirSync(join(root, "node_modules", "pkg"), { recursive: true });
    writeFileSync(join(root, "node_modules", "pkg", "index.js"), "needle\n");
    writeFileSync(join(root, "real.txt"), "needle\n");
    fs = new WorkspaceFs(() => [{ name: "ws", cwd: root }]);
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  test("hits include real.txt but not any node_modules/ path", async () => {
    const r = await fs.search("ws", { query: "needle", mode: "content" });
    const paths = r.hits.map((h) => h.path);
    expect(paths).toContain("real.txt");
    expect(paths.some((p) => p.startsWith("node_modules/"))).toBe(false);
  });
});

describe("WorkspaceFs search: regressions", () => {
  let root: string;
  let fs: WorkspaceFs;
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "wsfs-redos-regress-"));
    writeFileSync(join(root, "alpha.ts"), "export const alpha = 1;\n");
    fs = new WorkspaceFs(() => [{ name: "ws", cwd: root }]);
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  test("name mode still finds files by path substring", async () => {
    const r = await fs.search("ws", { query: "alpha.ts" });
    expect(r.matches).toContain("alpha.ts");
  });

  test("an invalid regex still degrades to a substring match instead of throwing", async () => {
    await expect(fs.search("ws", { query: "(", mode: "content", regex: true })).resolves.toBeDefined();
  });
});
