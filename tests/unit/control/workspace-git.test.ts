import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { WorkspaceGit, worktreePathIsWithin, worktreePathsEqual } from "../../../src/control/workspace-git";

const cleanups: string[] = [];

function temp(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(path);
  return path;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

async function runGitWithWindowsWorktreePaths(_root: string, args: string[]): Promise<string> {
  // runRaw hands the override the full argv, already prefixed with ["-C", root, "-c", "gc.auto=0"].
  const output = execFileSync("git", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (!args.join("\0").endsWith(["worktree", "list", "--porcelain"].join("\0"))) return output;
  return output.replace(/^worktree (.+)$/gm, (_line, path: string) => `worktree ${path.replaceAll("/", "\\")}`);
}

function initRepo(): { repo: string; remote: string } {
  const remote = temp("wsgit-remote-");
  execFileSync("git", ["init", "--bare", "-q", remote]);
  const repo = temp("wsgit-repo-");
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "user.name", "Test User");
  writeFileSync(join(repo, "README.md"), "initial\n");
  git(repo, "add", "README.md");
  git(repo, "commit", "-qm", "initial");
  git(repo, "remote", "add", "origin", remote);
  git(repo, "push", "-qu", "origin", "main");
  execFileSync("git", ["--git-dir", remote, "symbolic-ref", "HEAD", "refs/heads/main"]);
  return { repo, remote };
}

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (!existsSync(path)) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${path}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

afterEach(() => {
  for (const path of cleanups.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("worktreePathsEqual", () => {
  test("matches Git and Node representations of the same Windows path", () => {
    expect(worktreePathsEqual("C:/Users/Alice/repo", "C:\\Users\\Alice\\repo", "win32")).toBe(true);
    expect(worktreePathsEqual("c:/users/alice/repo", "C:\\Users\\Alice\\repo", "win32")).toBe(true);
    expect(worktreePathsEqual("C:/Users/Alice/repo/", "C:\\Users\\Alice\\repo", "win32")).toBe(true);
    expect(worktreePathsEqual("\\\\?\\C:\\Users\\Alice\\repo", "C:\\Users\\Alice\\repo", "win32")).toBe(true);
    expect(worktreePathsEqual("\\\\?\\UNC\\server\\share\\repo", "\\\\server\\share\\repo", "win32")).toBe(true);
  });

  test("keeps POSIX path comparison case-sensitive", () => {
    expect(worktreePathsEqual("/tmp/Repo", "/tmp/repo", "linux")).toBe(false);
  });
});

describe("worktreePathIsWithin", () => {
  test("matches Windows paths case-insensitively without accepting prefix siblings", () => {
    expect(worktreePathIsWithin("C:/worktrees", "c:\\WORKTREES\\repo", "win32")).toBe(true);
    expect(worktreePathIsWithin("C:/worktrees", "C:\\worktreesEVIL\\repo", "win32")).toBe(false);
    expect(worktreePathIsWithin("C:/worktrees", "C:\\worktrees", "win32")).toBe(false);
  });

  test("keeps POSIX containment case-sensitive", () => {
    expect(worktreePathIsWithin("/tmp/worktrees", "/tmp/worktrees/repo", "linux")).toBe(true);
    expect(worktreePathIsWithin("/tmp/worktrees", "/tmp/Worktrees/repo", "linux")).toBe(false);
  });
});

describe("WorkspaceGit status", () => {
  test("matches Windows-shaped Git worktree output through the status wiring", async () => {
    const { repo } = initRepo();
    const service = new WorkspaceGit(
      () => [{ name: "project", cwd: repo }],
      { platform: "win32", runGit: runGitWithWindowsWorktreePaths },
    );

    const status = await service.status("project");

    expect(worktreePathsEqual(status.worktree.root, realpathSync(repo), "win32")).toBe(true);
    expect(status.worktrees).toContainEqual(expect.objectContaining({ current: true }));
  });

  test("reports the symbolic branch in an unborn repository", async () => {
    const repo = temp("wsgit-empty-");
    git(repo, "init", "-q", "-b", "main");
    writeFileSync(join(repo, "first.txt"), "first\n");
    const service = new WorkspaceGit(() => [{ name: "project", cwd: repo }]);

    expect(await service.status("project")).toMatchObject({
      workspace: "project",
      branch: "main",
      detached: false,
      ahead: 0,
      behind: 0,
      files: [{ path: "first.txt", status: "??" }],
    });
  });

  test("lists each untracked file inside a directory instead of a collapsed dir entry", async () => {
    const { repo } = initRepo();
    mkdirSync(join(repo, "sub"));
    writeFileSync(join(repo, "sub", "a.txt"), "a\n");
    writeFileSync(join(repo, "sub", "b.txt"), "b\n");
    const service = new WorkspaceGit(() => [{ name: "project", cwd: repo }]);

    const status = await service.status("project");

    expect(status.files).toEqual([
      { path: "sub/a.txt", status: "??" },
      { path: "sub/b.txt", status: "??" },
    ]);
  });

  test("passes gc.auto=0 to every git invocation, visible through the runGit override", async () => {
    const { repo } = initRepo();
    const seen: string[][] = [];
    const service = new WorkspaceGit(
      () => [{ name: "project", cwd: repo }],
      {
        runGit: async (_root, args) => {
          seen.push(args);
          return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
        },
      },
    );

    await service.status("project");

    expect(seen.length).toBeGreaterThan(0);
    for (const args of seen) {
      const index = args.indexOf("gc.auto=0");
      expect(index).toBeGreaterThan(0);
      expect(args[index - 1]).toBe("-c");
    }
  });

  test("reports branch, upstream divergence, local branches, and linked worktrees", async () => {
    const { repo, remote } = initRepo();
    git(repo, "checkout", "-qb", "feature");
    git(repo, "push", "-qu", "origin", "feature");

    writeFileSync(join(repo, "local.txt"), "local\n");
    git(repo, "add", "local.txt");
    git(repo, "commit", "-qm", "local ahead");

    const other = temp("wsgit-peer-");
    git(other, "clone", "-q", remote, ".");
    git(other, "config", "user.email", "peer@example.com");
    git(other, "config", "user.name", "Peer User");
    git(other, "checkout", "-q", "feature");
    writeFileSync(join(other, "remote.txt"), "remote\n");
    git(other, "add", "remote.txt");
    git(other, "commit", "-qm", "remote ahead");
    git(other, "push", "-q", "origin", "feature");
    git(repo, "fetch", "-q", "origin");

    const linked = temp("wsgit-linked-");
    git(repo, "worktree", "add", "-q", "-b", "review", linked, "main");

    const service = new WorkspaceGit(() => [{ name: "project", cwd: repo }]);
    const status = await service.status("project");

    expect(status).toMatchObject({
      workspace: "project",
      branch: "feature",
      upstream: "origin/feature",
      ahead: 1,
      behind: 1,
      detached: false,
    });
    expect(status.branches).toEqual([
      { name: "feature", current: true, worktreePath: status.worktree.root },
      { name: "main", current: false },
      { name: "review", current: false, worktreePath: realpathSync(linked) },
    ]);
    expect(status.worktrees).toEqual([
      { path: status.worktree.root, branch: "feature", current: true, linked: false },
      { path: realpathSync(linked), branch: "review", current: false, linked: true },
    ]);
    expect(basename(status.worktree.root)).toBe(basename(repo));
  });
});

describe("WorkspaceGit index", () => {
  test("stages and unstages only the selected workspace-relative path", async () => {
    const { repo } = initRepo();
    writeFileSync(join(repo, "README.md"), "changed\n");
    writeFileSync(join(repo, "notes.txt"), "untracked\n");
    const service = new WorkspaceGit(() => [{ name: "project", cwd: repo }]);

    await service.stage("project", ["notes.txt"]);
    expect((await service.status("project")).files).toEqual([
      { path: "README.md", status: " M" },
      { path: "notes.txt", status: "A " },
    ]);

    await service.unstage("project", ["notes.txt"]);
    expect((await service.status("project")).files).toEqual([
      { path: "README.md", status: " M" },
      { path: "notes.txt", status: "??" },
    ]);
  });

  test("commits only staged files and leaves unstaged changes in the worktree", async () => {
    const { repo } = initRepo();
    writeFileSync(join(repo, "README.md"), "unstaged\n");
    writeFileSync(join(repo, "ready.txt"), "ready\n");
    const service = new WorkspaceGit(() => [{ name: "project", cwd: repo }]);
    await service.stage("project", ["ready.txt"]);

    const result = await service.commit("project", "feat: add ready file");

    expect(result.summary).toBe("feat: add ready file");
    expect(result.shortHash).toMatch(/^[0-9a-f]{7,12}$/);
    expect(result.hash).toStartWith(result.shortHash);
    expect((await service.status("project")).files).toEqual([
      { path: "README.md", status: " M" },
    ]);
  });

  test("treats selected paths literally instead of expanding Git pathspec magic", async () => {
    const { repo } = initRepo();
    writeFileSync(join(repo, ":(top)**"), "literal\n");
    writeFileSync(join(repo, "README.md"), "unrelated\n");
    const service = new WorkspaceGit(() => [{ name: "project", cwd: repo }]);

    await service.stage("project", [":(top)**"]);

    expect((await service.status("project")).files).toEqual([
      { path: ":(top)**", status: "A " },
      { path: "README.md", status: " M" },
    ]);
  });

  test("unstages both sides of a staged rename when the destination row is selected", async () => {
    const { repo } = initRepo();
    git(repo, "mv", "README.md", "RENAMED.md");
    const service = new WorkspaceGit(() => [{ name: "project", cwd: repo }]);

    await service.unstage("project", ["RENAMED.md"]);

    expect((await service.status("project")).files).toEqual([
      { path: "README.md", status: " D" },
      { path: "RENAMED.md", status: "??" },
    ]);
  });
});

describe("WorkspaceGit untrack", () => {
  test("removes a committed file from the index while keeping it on disk", async () => {
    const { repo } = initRepo();
    const service = new WorkspaceGit(() => [{ name: "project", cwd: repo }]);

    await service.untrack("project", ["README.md"]);

    expect(existsSync(join(repo, "README.md"))).toBe(true);
    expect((await service.status("project")).files).toEqual([
      { path: "README.md", status: "D " },
      { path: "README.md", status: "??" },
    ]);
  });

  test("returns a staged new file to untracked", async () => {
    const { repo } = initRepo();
    writeFileSync(join(repo, "notes.txt"), "new\n");
    const service = new WorkspaceGit(() => [{ name: "project", cwd: repo }]);
    await service.stage("project", ["notes.txt"]);

    await service.untrack("project", ["notes.txt"]);

    expect(existsSync(join(repo, "notes.txt"))).toBe(true);
    expect((await service.status("project")).files).toEqual([
      { path: "notes.txt", status: "??" },
    ]);
  });

  test("untracks a file whose staged content differs from both HEAD and worktree", async () => {
    const { repo } = initRepo();
    writeFileSync(join(repo, "README.md"), "staged\n");
    const service = new WorkspaceGit(() => [{ name: "project", cwd: repo }]);
    await service.stage("project", ["README.md"]);
    writeFileSync(join(repo, "README.md"), "worktree\n");

    await service.untrack("project", ["README.md"]);

    expect(readFileSync(join(repo, "README.md"), "utf8")).toBe("worktree\n");
    expect((await service.status("project")).files).toEqual([
      { path: "README.md", status: "D " },
      { path: "README.md", status: "??" },
    ]);
  });

  test("rejects escaping paths", async () => {
    const { repo } = initRepo();
    const service = new WorkspaceGit(() => [{ name: "project", cwd: repo }]);

    await expect(service.untrack("project", ["../outside.txt"])).rejects.toThrow("invalid-git-path");
    await expect(service.untrack("project", [])).rejects.toThrow("git-paths-required");
  });
});

describe("WorkspaceGit discard", () => {
  test("restores staged and unstaged edits of a tracked file to HEAD", async () => {
    const { repo } = initRepo();
    writeFileSync(join(repo, "README.md"), "staged\n");
    const service = new WorkspaceGit(() => [{ name: "project", cwd: repo }]);
    await service.stage("project", ["README.md"]);
    writeFileSync(join(repo, "README.md"), "worktree\n");

    await service.discard("project", ["README.md"]);

    expect(readFileSync(join(repo, "README.md"), "utf8")).toBe("initial\n");
    expect((await service.status("project")).files).toEqual([]);
  });

  test("recovers a staged deletion from HEAD", async () => {
    const { repo } = initRepo();
    const service = new WorkspaceGit(() => [{ name: "project", cwd: repo }]);
    git(repo, "rm", "-q", "README.md");

    await service.discard("project", ["README.md"]);

    expect(readFileSync(join(repo, "README.md"), "utf8")).toBe("initial\n");
    expect((await service.status("project")).files).toEqual([]);
  });

  test("deletes a staged new file from index and disk", async () => {
    const { repo } = initRepo();
    writeFileSync(join(repo, "notes.txt"), "new\n");
    const service = new WorkspaceGit(() => [{ name: "project", cwd: repo }]);
    await service.stage("project", ["notes.txt"]);

    await service.discard("project", ["notes.txt"]);

    expect(existsSync(join(repo, "notes.txt"))).toBe(false);
    expect((await service.status("project")).files).toEqual([]);
  });

  test("deletes an untracked file from disk", async () => {
    const { repo } = initRepo();
    writeFileSync(join(repo, "scratch.txt"), "scratch\n");
    const service = new WorkspaceGit(() => [{ name: "project", cwd: repo }]);

    await service.discard("project", ["scratch.txt"]);

    expect(existsSync(join(repo, "scratch.txt"))).toBe(false);
    expect((await service.status("project")).files).toEqual([]);
  });

  test("discarding a staged rename target restores the source and removes the target", async () => {
    const { repo } = initRepo();
    git(repo, "mv", "README.md", "RENAMED.md");
    const service = new WorkspaceGit(() => [{ name: "project", cwd: repo }]);

    await service.discard("project", ["RENAMED.md"]);

    expect(existsSync(join(repo, "RENAMED.md"))).toBe(false);
    expect(readFileSync(join(repo, "README.md"), "utf8")).toBe("initial\n");
    expect((await service.status("project")).files).toEqual([]);
  });

  test("only touches the selected paths", async () => {
    const { repo } = initRepo();
    writeFileSync(join(repo, "README.md"), "keep me dirty\n");
    writeFileSync(join(repo, "scratch.txt"), "scratch\n");
    const service = new WorkspaceGit(() => [{ name: "project", cwd: repo }]);

    await service.discard("project", ["scratch.txt"]);

    expect(readFileSync(join(repo, "README.md"), "utf8")).toBe("keep me dirty\n");
    expect((await service.status("project")).files).toEqual([
      { path: "README.md", status: " M" },
    ]);
  });

  test("handles an unborn repository by deleting instead of restoring from HEAD", async () => {
    const repo = temp("wsgit-empty-");
    git(repo, "init", "-q", "-b", "main");
    writeFileSync(join(repo, "first.txt"), "first\n");
    const service = new WorkspaceGit(() => [{ name: "project", cwd: repo }]);

    await service.discard("project", ["first.txt"]);

    expect(existsSync(join(repo, "first.txt"))).toBe(false);
    expect((await service.status("project")).files).toEqual([]);
  });

  test("rejects escaping paths", async () => {
    const { repo } = initRepo();
    const service = new WorkspaceGit(() => [{ name: "project", cwd: repo }]);

    await expect(service.discard("project", ["/etc/passwd"])).rejects.toThrow("invalid-git-path");
  });
});

describe("WorkspaceGit branches", () => {
  test("refuses to switch a dirty worktree and switches once it is clean", async () => {
    const { repo } = initRepo();
    git(repo, "branch", "feature");
    writeFileSync(join(repo, "README.md"), "dirty\n");
    const service = new WorkspaceGit(() => [{ name: "project", cwd: repo }]);

    await expect(service.checkout("project", { branch: "feature" })).rejects.toThrow("dirty-worktree");
    expect((await service.status("project")).branch).toBe("main");

    git(repo, "restore", "README.md");
    await service.checkout("project", { branch: "feature" });
    expect((await service.status("project")).branch).toBe("feature");
  });

  test("creates a branch from an explicit start point and switches to it", async () => {
    const { repo } = initRepo();
    const service = new WorkspaceGit(() => [{ name: "project", cwd: repo }]);

    await service.checkout("project", { branch: "feature/ui", create: true, startPoint: "main" });

    const status = await service.status("project");
    expect(status.branch).toBe("feature/ui");
    expect(status.branches.some((branch) => branch.name === "feature/ui" && branch.current)).toBe(true);
  });
});

describe("WorkspaceGit synchronization", () => {
  test("fetches remote refs and pulls only as a clean fast-forward", async () => {
    const { repo, remote } = initRepo();
    const peer = temp("wsgit-peer-");
    git(peer, "clone", "-q", remote, ".");
    git(peer, "config", "user.email", "peer@example.com");
    git(peer, "config", "user.name", "Peer User");
    writeFileSync(join(peer, "remote.txt"), "remote\n");
    git(peer, "add", "remote.txt");
    git(peer, "commit", "-qm", "remote commit");
    git(peer, "push", "-q", "origin", "main");
    const service = new WorkspaceGit(() => [{ name: "project", cwd: repo }]);

    await service.fetch("project");
    expect((await service.status("project")).behind).toBe(1);

    writeFileSync(join(repo, "README.md"), "dirty\n");
    await expect(service.pull("project")).rejects.toThrow("dirty-worktree");
    expect((await service.status("project")).behind).toBe(1);

    git(repo, "restore", "README.md");
    await service.pull("project");
    expect(await service.status("project")).toMatchObject({ ahead: 0, behind: 0 });
  });

  test("requires explicit upstream setup for a first push", async () => {
    const { repo } = initRepo();
    const service = new WorkspaceGit(() => [{ name: "project", cwd: repo }]);
    await service.checkout("project", { branch: "feature/push", create: true });
    writeFileSync(join(repo, "push.txt"), "push\n");
    await service.stage("project", ["push.txt"]);
    await service.commit("project", "feat: push branch");

    await expect(service.push("project")).rejects.toThrow("no-upstream");
    await service.push("project", { setUpstream: true, remote: "origin" });

    expect(await service.status("project")).toMatchObject({
      branch: "feature/push",
      upstream: "origin/feature/push",
      ahead: 0,
      behind: 0,
    });
  });

  test("serializes writes to the same workspace", async () => {
    const { repo } = initRepo();
    writeFileSync(join(repo, "first.txt"), "first\n");
    const service = new WorkspaceGit(() => [{ name: "project", cwd: repo }]);
    await service.stage("project", ["first.txt"]);
    await service.commit("project", "first local commit");

    const hookDir = join(repo, git(repo, "rev-parse", "--git-path", "hooks"));
    const entered = join(hookDir, "push-entered");
    const release = join(hookDir, "push-release");
    const hook = join(hookDir, "pre-push");
    writeFileSync(hook, `#!/bin/sh\ntouch '${entered}'\nwhile [ ! -f '${release}' ]; do sleep 0.01; done\n`);
    chmodSync(hook, 0o755);

    const pushing = service.push("project");
    await waitForFile(entered);
    writeFileSync(join(repo, "second.txt"), "second\n");
    const staging = service.stage("project", ["second.txt"]);

    // The push is still blocked in its hook, so a same-workspace stage must remain queued.
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect((await service.status("project")).files).toContainEqual({ path: "second.txt", status: "??" });

    writeFileSync(release, "release\n");
    await Promise.all([pushing, staging]);
    expect((await service.status("project")).files).toContainEqual({ path: "second.txt", status: "A " });
  });
});

describe("WorkspaceGit worktrees", () => {
  test("removes a managed worktree when Git reports a Windows-shaped path", async () => {
    const { repo } = initRepo();
    const managedRoot = temp("wsgit-managed-");
    const nativeService = new WorkspaceGit(
      () => [{ name: "project", cwd: repo }],
      { managedWorktreesRoot: managedRoot },
    );
    const created = await nativeService.createWorktree("project", {
      branch: "feature/windows-rollback",
      createBranch: true,
      startPoint: "main",
    });
    const windowsService = new WorkspaceGit(
      () => [{ name: "project", cwd: repo }],
      {
        managedWorktreesRoot: managedRoot,
        platform: "win32",
        runGit: runGitWithWindowsWorktreePaths,
      },
    );

    await windowsService.removeManagedWorktree("project", created.path);

    expect(existsSync(created.path)).toBe(false);
    expect((await nativeService.status("project")).worktrees).toHaveLength(1);
  });

  test("rejects a managed repo directory symlink before creating outside the root", async () => {
    const { repo } = initRepo();
    const managedRoot = temp("wsgit-managed-");
    const outside = temp("wsgit-outside-");
    const commonDir = git(repo, "rev-parse", "--path-format=absolute", "--git-common-dir");
    const top = git(repo, "rev-parse", "--show-toplevel");
    const repoKey = `${basename(top)}-${createHash("sha256").update(commonDir).digest("hex").slice(0, 8)}`;
    symlinkSync(outside, join(managedRoot, repoKey));
    const service = new WorkspaceGit(
      () => [{ name: "project", cwd: repo }],
      { managedWorktreesRoot: managedRoot },
    );

    await expect(service.createWorktree("project", {
      branch: "feature/escaped",
      createBranch: true,
      startPoint: "main",
    })).rejects.toThrow("worktree-path-unsafe");
    expect(existsSync(join(outside, "feature-escaped"))).toBe(false);
    expect((await service.status("project")).worktrees).toHaveLength(1);
  });

  test("creates a linked worktree under the server-managed root", async () => {
    const { repo } = initRepo();
    const managedRoot = temp("wsgit-managed-");
    const service = new WorkspaceGit(
      () => [{ name: "project", cwd: repo }],
      { managedWorktreesRoot: managedRoot },
    );

    const created = await service.createWorktree("project", {
      branch: "feature/worktree-ui",
      createBranch: true,
      startPoint: "main",
    });

    expect(created).toMatchObject({ branch: "feature/worktree-ui", linked: true });
    expect(created.path.startsWith(realpathSync(managedRoot) + "/")).toBe(true);
    expect((await service.status("project")).worktrees).toContainEqual({
      path: created.path,
      branch: "feature/worktree-ui",
      current: false,
      linked: true,
    });
  });
});
