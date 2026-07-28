import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve, sep, win32 } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 30_000;
const GIT_MAX_BUFFER = 8 * 1024 * 1024;

export interface GitWorkspaceRef {
  name: string;
  cwd: string;
}

export interface GitBranchInfo {
  name: string;
  current: boolean;
  /** Present when Git reports this branch checked out in a worktree. */
  worktreePath?: string;
}

export interface GitWorktreeInfo {
  path: string;
  branch?: string;
  detached?: boolean;
  current: boolean;
  linked: boolean;
}

export interface GitStatus {
  workspace: string;
  branch?: string;
  detached: boolean;
  upstream?: string;
  ahead: number;
  behind: number;
  worktree: { root: string; linked: boolean };
  files: Array<{ path: string; status: string }>;
  branches: GitBranchInfo[];
  worktrees: GitWorktreeInfo[];
}

export interface GitCommitResult {
  hash: string;
  shortHash: string;
  summary: string;
}

export interface GitCheckoutOptions {
  branch: string;
  create?: boolean;
  startPoint?: string;
}

export interface GitPushOptions {
  setUpstream?: boolean;
  remote?: string;
}

export interface GitWorktreeCreateOptions {
  branch: string;
  createBranch?: boolean;
  startPoint?: string;
}

export interface GitWorktreeCreateResult {
  path: string;
  branch: string;
  linked: true;
}

function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith(`~${sep}`) || path.startsWith("~/")) return resolve(homedir(), path.slice(2));
  return path;
}

export function worktreePathsEqual(
  left: string,
  right: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (platform === "win32") {
    return normalizeWindowsWorktreePath(left) === normalizeWindowsWorktreePath(right);
  }
  return left === right;
}

export function worktreePathIsWithin(
  parent: string,
  child: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const normalizedParent = platform === "win32" ? normalizeWindowsWorktreePath(parent) : parent;
  const normalizedChild = platform === "win32" ? normalizeWindowsWorktreePath(child) : child;
  if (normalizedParent === normalizedChild) return false;
  const separator = platform === "win32" ? win32.sep : sep;
  const parentPrefix = normalizedParent.endsWith(separator)
    ? normalizedParent
    : normalizedParent + separator;
  return normalizedChild.startsWith(parentPrefix);
}

function normalizeWindowsWorktreePath(path: string): string {
  // Git for Windows may report C:/repo while fs.realpath returns C:\repo.
  // Extended-length paths are the same filesystem location with a device prefix.
  let normalized = win32.normalize(path);
  const folded = normalized.toLowerCase();
  if (folded.startsWith("\\\\?\\unc\\")) {
    normalized = `\\\\${normalized.slice(8)}`;
  } else if (folded.startsWith("\\\\?\\")) {
    normalized = normalized.slice(4);
  }
  normalized = win32.normalize(normalized);
  const root = win32.parse(normalized).root;
  while (normalized.length > root.length && normalized.endsWith(win32.sep)) {
    normalized = normalized.slice(0, -1);
  }
  return normalized.toLowerCase();
}

export interface WorkspaceGitOptions {
  managedWorktreesRoot?: string;
  platform?: NodeJS.Platform;
  runGit?: (root: string, args: string[]) => Promise<string>;
}

export class WorkspaceGit {
  private readonly managedWorktreesRoot: string;
  private readonly platform: NodeJS.Platform;
  private readonly runGitOverride: WorkspaceGitOptions["runGit"];
  private readonly writeTails = new Map<string, Promise<void>>();

  constructor(
    private readonly listWorkspaces: () => GitWorkspaceRef[],
    options: WorkspaceGitOptions = {},
  ) {
    this.managedWorktreesRoot = options.managedWorktreesRoot ?? join(homedir(), ".xacpx", "worktrees");
    this.platform = options.platform ?? process.platform;
    this.runGitOverride = options.runGit;
  }

  private async rootFor(workspace: string): Promise<string> {
    const ref = this.listWorkspaces().find((item) => item.name === workspace);
    if (!ref) throw new Error("unknown-workspace");
    try {
      return await realpath(expandHome(ref.cwd));
    } catch {
      throw new Error("workspace-root-missing");
    }
  }

  private async run(root: string, args: string[]): Promise<string> {
    return (await this.runRaw(root, args)).trim();
  }

  private async runRaw(root: string, args: string[]): Promise<string> {
    // gc.auto=0: commit/fetch may spawn a detached background `git gc --auto` that
    // inherits our stderr pipe; execFile then waits for stdio close, times out, and
    // reports "Command failed" even though the git command itself succeeded.
    // Assemble the full argv before the test override so injected runners see it too.
    const fullArgs = ["-C", root, "-c", "gc.auto=0", ...args];
    if (this.runGitOverride) return await this.runGitOverride(root, fullArgs);
    const result = await execFileAsync("git", fullArgs, {
      timeout: GIT_TIMEOUT_MS,
      killSignal: "SIGKILL",
      maxBuffer: GIT_MAX_BUFFER,
    });
    return result.stdout;
  }

  private validatePaths(paths: string[]): string[] {
    if (!paths.length) throw new Error("git-paths-required");
    for (const path of paths) {
      if (!path || isAbsolute(path) || path.split(/[\\/]/).includes("..")) {
        throw new Error("invalid-git-path");
      }
    }
    return paths;
  }

  private async validateBranch(root: string, raw: string): Promise<string> {
    const branch = raw.trim();
    if (!branch) throw new Error("branch-required");
    try {
      await this.run(root, ["check-ref-format", "--branch", branch]);
    } catch {
      throw new Error("invalid-branch-name");
    }
    return branch;
  }

  private async validateStartPoint(root: string, raw?: string): Promise<string | undefined> {
    const startPoint = raw?.trim();
    if (!startPoint) return undefined;
    try {
      await this.run(root, ["rev-parse", "--verify", "--end-of-options", `${startPoint}^{commit}`]);
    } catch {
      throw new Error("invalid-start-point");
    }
    return startPoint;
  }

  private async includeRenameSources(root: string, paths: string[]): Promise<string[]> {
    const selected = new Set(paths);
    const expanded = new Set(paths);
    const fields = (await this.runRaw(root, ["-c", "core.quotePath=false", "status", "--porcelain", "-z"])).split("\0");
    for (let index = 0; index < fields.length; index += 1) {
      const field = fields[index];
      if (!field) continue;
      const status = field.slice(0, 2);
      const path = field.slice(3);
      if (status[0] !== "R" && status[0] !== "C") continue;
      const originalPath = fields[++index];
      if (originalPath && selected.has(path)) expanded.add(originalPath);
    }
    return [...expanded];
  }

  /** Git write commands for one configured workspace share a FIFO. Reads remain
   * concurrent, and a failed write releases the next command instead of poisoning
   * the queue. */
  private async withWrite<T>(workspace: string, action: () => Promise<T>): Promise<T> {
    const previous = this.writeTails.get(workspace) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.catch(() => {}).then(() => current);
    this.writeTails.set(workspace, tail);
    await previous.catch(() => {});
    try {
      return await action();
    } finally {
      release();
      if (this.writeTails.get(workspace) === tail) this.writeTails.delete(workspace);
    }
  }

  async stage(workspace: string, paths: string[]): Promise<void> {
    await this.withWrite(workspace, async () => {
      const root = await this.rootFor(workspace);
      await this.run(root, ["--literal-pathspecs", "add", "--", ...this.validatePaths(paths)]);
    });
  }

  async unstage(workspace: string, paths: string[]): Promise<void> {
    await this.withWrite(workspace, async () => {
      const root = await this.rootFor(workspace);
      const valid = await this.includeRenameSources(root, this.validatePaths(paths));
      try {
        await this.run(root, ["--literal-pathspecs", "restore", "--staged", "--", ...valid]);
      } catch {
        await this.run(root, ["--literal-pathspecs", "reset", "--", ...valid]);
      }
    });
  }

  async commit(workspace: string, message: string): Promise<GitCommitResult> {
    return this.withWrite(workspace, async () => {
      const root = await this.rootFor(workspace);
      const normalized = message.trim();
      if (!normalized) throw new Error("commit-message-required");
      await this.run(root, ["commit", "-m", normalized]);
      const hash = await this.run(root, ["rev-parse", "HEAD"]);
      const shortHash = await this.run(root, ["rev-parse", "--short", "HEAD"]);
      const summary = await this.run(root, ["show", "-s", "--format=%s", "HEAD"]);
      return { hash, shortHash, summary };
    });
  }

  async checkout(workspace: string, options: GitCheckoutOptions): Promise<void> {
    await this.withWrite(workspace, async () => {
      const root = await this.rootFor(workspace);
      const branch = await this.validateBranch(root, options.branch);
      if ((await this.runRaw(root, ["status", "--porcelain", "-z"])) !== "") {
        throw new Error("dirty-worktree");
      }
      if (options.create) {
        const startPoint = await this.validateStartPoint(root, options.startPoint);
        await this.run(root, ["switch", "-c", branch, ...(startPoint ? [startPoint] : [])]);
        return;
      }
      await this.run(root, ["switch", branch]);
    });
  }

  async fetch(workspace: string, remote = "origin"): Promise<void> {
    await this.withWrite(workspace, async () => {
      const root = await this.rootFor(workspace);
      await this.assertRemote(root, remote);
      await this.run(root, ["fetch", "--prune", "--", remote]);
    });
  }

  async pull(workspace: string): Promise<void> {
    await this.withWrite(workspace, async () => {
      const root = await this.rootFor(workspace);
      if ((await this.runRaw(root, ["status", "--porcelain", "-z"])) !== "") {
        throw new Error("dirty-worktree");
      }
      try {
        await this.run(root, ["rev-parse", "--verify", "@{upstream}"]);
      } catch {
        throw new Error("no-upstream");
      }
      await this.run(root, ["pull", "--ff-only"]);
    });
  }

  async push(workspace: string, options: GitPushOptions = {}): Promise<void> {
    await this.withWrite(workspace, async () => {
      const root = await this.rootFor(workspace);
      if (options.setUpstream) {
        const remote = options.remote?.trim() || "origin";
        await this.assertRemote(root, remote);
        const branch = await this.run(root, ["rev-parse", "--abbrev-ref", "HEAD"]);
        if (branch === "HEAD") throw new Error("detached-head");
        await this.run(root, ["push", "--set-upstream", "--", remote, branch]);
        return;
      }
      try {
        await this.run(root, ["rev-parse", "--verify", "@{upstream}"]);
      } catch {
        throw new Error("no-upstream");
      }
      await this.run(root, ["push"]);
    });
  }

  async createWorktree(
    workspace: string,
    options: GitWorktreeCreateOptions,
  ): Promise<GitWorktreeCreateResult> {
    return this.withWrite(workspace, async () => {
      const root = await this.rootFor(workspace);
      const branch = await this.validateBranch(root, options.branch);
      const startPoint = await this.validateStartPoint(root, options.startPoint);

      await mkdir(this.managedWorktreesRoot, { recursive: true });
      const managedRoot = await realpath(this.managedWorktreesRoot);
      const commonDir = await this.run(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
      const top = await this.run(root, ["rev-parse", "--show-toplevel"]);
      const repoKey = `${basename(top)}-${createHash("sha256").update(commonDir).digest("hex").slice(0, 8)}`;
      const branchSlug = branch.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "branch";
      const branchKey = `${branchSlug}-${createHash("sha256").update(branch).digest("hex").slice(0, 6)}`;
      const repoDir = join(managedRoot, repoKey);
      try {
        const existing = await lstat(repoDir);
        if (!existing.isDirectory() || existing.isSymbolicLink()) throw new Error("worktree-path-unsafe");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        await mkdir(repoDir);
      }
      const realRepoDir = await realpath(repoDir);
      if (!worktreePathIsWithin(managedRoot, realRepoDir, this.platform)) throw new Error("worktree-path-unsafe");
      const target = join(realRepoDir, branchKey);
      try {
        await lstat(target);
        throw new Error("worktree-path-exists");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }

      if (options.createBranch) {
        await this.run(root, ["worktree", "add", "-b", branch, target, ...(startPoint ? [startPoint] : [])]);
      } else {
        await this.run(root, ["worktree", "add", target, branch]);
      }
      const createdPath = await realpath(target);
      if (!worktreePathIsWithin(managedRoot, createdPath, this.platform)) throw new Error("worktree-path-unsafe");
      return { path: createdPath, branch, linked: true };
    });
  }

  /** Internal compensation for a failed workspace-registration step. Not exposed as a
   * user-facing delete operation: it only accepts a non-current worktree beneath the
   * server-managed root. */
  async removeManagedWorktree(workspace: string, path: string): Promise<void> {
    await this.withWrite(workspace, async () => {
      const root = await this.rootFor(workspace);
      const managedRoot = await realpath(this.managedWorktreesRoot);
      const target = await realpath(path);
      if (!worktreePathIsWithin(managedRoot, target, this.platform)) throw new Error("worktree-outside-managed-root");
      const worktrees = await this.readWorktrees(root);
      const worktree = worktrees.find((item) => worktreePathsEqual(item.path, target, this.platform));
      if (!worktree) throw new Error("worktree-not-found");
      if (worktree.current) throw new Error("cannot-remove-current-worktree");
      await this.run(root, ["worktree", "remove", target]);
    });
  }

  private async assertRemote(root: string, remote: string): Promise<void> {
    const normalized = remote.trim();
    if (normalized.startsWith("-")) throw new Error("invalid-remote");
    const remotes = (await this.run(root, ["remote"])).split("\n").filter(Boolean);
    if (!normalized || !remotes.includes(normalized)) throw new Error("unknown-remote");
  }

  async status(workspace: string): Promise<GitStatus> {
    const root = await this.rootFor(workspace);
    try {
      await this.run(root, ["rev-parse", "--is-inside-work-tree"]);
    } catch {
      throw new Error("not-a-git-repo");
    }

    let head: string;
    try {
      head = await this.run(root, ["rev-parse", "--abbrev-ref", "HEAD"]);
    } catch {
      // HEAD has no commit yet, but its symbolic ref is still the active branch.
      try {
        head = await this.run(root, ["symbolic-ref", "--short", "HEAD"]);
      } catch {
        head = "HEAD";
      }
    }
    const branch = head === "HEAD" ? undefined : head;
    let upstream: string | undefined;
    let ahead = 0;
    let behind = 0;
    try {
      upstream = await this.run(root, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]);
      const [aheadRaw = "0", behindRaw = "0"] = (await this.run(
        root,
        ["rev-list", "--left-right", "--count", "HEAD...@{upstream}"],
      )).split(/\s+/);
      ahead = Number(aheadRaw) || 0;
      behind = Number(behindRaw) || 0;
    } catch {
      upstream = undefined;
    }

    const worktrees = await this.readWorktrees(root);
    const currentWorktree = worktrees.find((item) => item.current);
    if (!currentWorktree) throw new Error("git-worktree-context-missing");
    const branchesRaw = await this.run(root, [
      "for-each-ref",
      "--format=%(refname:short)%00%(worktreepath)",
      "refs/heads",
    ]);
    const branches = branchesRaw === "" ? [] : branchesRaw.split("\n").map((line): GitBranchInfo => {
      const [name = "", worktreePath = ""] = line.split("\0");
      return {
        name,
        current: name === branch,
        ...(worktreePath ? { worktreePath } : {}),
      };
    });
    const files: Array<{ path: string; status: string }> = [];
    try {
      // -uall expansion can exceed GIT_MAX_BUFFER in pathological repos; degrade to an
      // empty file list instead of failing the whole status call (branch/worktree info stays).
      const statusRaw = await this.runRaw(root, ["-c", "core.quotePath=false", "status", "--porcelain", "-z", "--untracked-files=all"]);
      const fields = statusRaw.split("\0");
      for (let index = 0; index < fields.length; index += 1) {
        const field = fields[index];
        if (!field) continue;
        const status = field.slice(0, 2);
        const path = field.slice(3);
        if (status[0] === "R" || status[0] === "C") index += 1;
        files.push({ path, status });
      }
    } catch {
      /* status failed — leave files empty, return the rest of the status */
    }
    files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

    return {
      workspace,
      ...(branch ? { branch } : {}),
      detached: !branch,
      ...(upstream ? { upstream } : {}),
      ahead,
      behind,
      worktree: { root: currentWorktree.path, linked: currentWorktree.linked },
      files,
      branches,
      worktrees,
    };
  }

  private async readWorktrees(root: string): Promise<GitWorktreeInfo[]> {
    const output = await this.run(root, ["worktree", "list", "--porcelain"]);
    const blocks = output.split(/\n\n+/).filter(Boolean);
    const parsed = blocks.map((block) => {
      let path = "";
      let branch: string | undefined;
      let detached = false;
      for (const line of block.split("\n")) {
        if (line.startsWith("worktree ")) path = line.slice("worktree ".length);
        else if (line.startsWith("branch refs/heads/")) branch = line.slice("branch refs/heads/".length);
        else if (line === "detached") detached = true;
      }
      return { path, branch, detached };
    });
    const currentRoot = await realpath(root);
    return parsed.map((item, index) => ({
      path: item.path,
      ...(item.branch ? { branch: item.branch } : {}),
      ...(item.detached ? { detached: true } : {}),
      current: worktreePathsEqual(item.path, currentRoot, this.platform),
      linked: index !== 0,
    }));
  }
}
