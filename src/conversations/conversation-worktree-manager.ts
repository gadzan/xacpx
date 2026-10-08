import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { lstat, mkdir, mkdtemp, realpath, rmdir, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { runWorkspaceGit, runWorkspaceGitPreview, runWorkspaceGitSync, worktreePathsEqual, worktreePathIsWithin } from "../control/workspace-git";
import type { AppConfig } from "../config/types";
import type { LogicalSession } from "../state/types";
import { AsyncMutex } from "../orchestration/async-mutex";
import { ConversationError } from "./conversation-error";
import type { ConversationWorktreeStore } from "./conversation-worktree-store";
import type { ConversationWorktreeBase, ConversationWorktreeRef, ConversationWorktreeResource, ConversationWorktreeRun, WorktreePreviewMember } from "./conversation-worktree-types";

const digest = (s: string): string => createHash("sha256").update(s).digest("hex").slice(0, 24);
const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e)).replace(/xacpx-conversation:[a-f0-9-]{36}/g, "[worktree owner]").slice(0, 8192);
const now = (): string => new Date().toISOString();
function fail(code: string, message: string): never { throw new ConversationError(code, message); }
const safeGit = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "commit.gpgSign=false",
  "-c", "rerere.enabled=false", "-c", "merge.default=text", "-c", "gc.auto=0", "-c", "maintenance.auto=false"];
export interface WorktreeManagerHooks { checkpoint?: (point: string, runId: string) => Promise<void> }

/** One durable owner, backed by Git registration and an opaque worktree lock. */
export class ConversationWorktreeManager {
  private readonly gates = new Map<string, { mutex: AsyncMutex; users: number }>();
  constructor(readonly registry: ConversationWorktreeStore, readonly root: string,
    private readonly config: Pick<AppConfig, "workspaces">, private readonly hooks: WorktreeManagerHooks = {}) {}
  async exclusive<T>(id: string, fn: () => Promise<T>): Promise<T> {
    let entry = this.gates.get(id); if (!entry) { entry = { mutex: new AsyncMutex(), users: 0 }; this.gates.set(id, entry); }
    entry.users++;
    try { return await entry.mutex.run(fn); }
    finally { if (--entry.users === 0) this.gates.delete(id); }
  }
  git(cwd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
    return runWorkspaceGit(cwd, [...safeGit, ...args], this.gitEnvironment(env))
      .catch(error => { throw new ConversationError("worktree_git_failed", errorText(error)); });
  }
  private gitEnvironment(env?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    return { GIT_DIR: undefined, GIT_WORK_TREE: undefined,
      GIT_COMMON_DIR: undefined, GIT_INDEX_FILE: undefined, GIT_OBJECT_DIRECTORY: undefined,
      GIT_ALTERNATE_OBJECT_DIRECTORIES: undefined, GIT_CONFIG_PARAMETERS: undefined, GIT_CONFIG_COUNT: undefined, ...env };
  }
  private currentBranch(cwd: string): string {
    try { return runWorkspaceGitSync(cwd, [...safeGit, "symbolic-ref", "--quiet", "HEAD"], this.gitEnvironment()).trim(); }
    catch (error) { throw new ConversationError("worktree_git_failed", errorText(error)); }
  }
  async checkpoint(point: string, id: string): Promise<void> { await this.hooks.checkpoint?.(point, id); }
  async preflight(workspace: string): Promise<ConversationWorktreeBase> {
    const configured = this.config.workspaces[workspace];
    if (!configured) fail("worktree_workspace_missing", "worktree execution requires a registered workspace");
    const sourceRoot = await realpath(configured.cwd);
    const gitRoot = await realpath((await this.git(sourceRoot, ["rev-parse", "--show-toplevel"])).trim());
    if (!worktreePathsEqual(sourceRoot, gitRoot)) fail("worktree_workspace_not_root", "register the Git worktree root as the workspace");
    const commonDir = await realpath((await this.git(sourceRoot, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).trim());
    if (/[\r\n]/.test(sourceRoot + commonDir)) fail("worktree_path_unsafe", "repository paths cannot contain line breaks");
    const baseCommitSha = (await this.git(sourceRoot, ["rev-parse", "--verify", "HEAD^{commit}"])).trim();
    if ((await this.git(sourceRoot, ["status", "--porcelain=v1", "-z", "--untracked-files=all"])).length) {
      fail("worktree_workspace_dirty", "commit or move source workspace changes before accepting a worktree Run");
    }
    await this.managedRoot(sourceRoot, commonDir);
    await this.assertSupportedTree(sourceRoot);
    return { workspace, sourceRoot, commonDir, baseCommitSha,
      repositoryIdentity: digest(process.platform === "win32" ? commonDir.toLowerCase() : commonDir) };
  }
  private async managedRoot(sourceRoot: string, commonDir: string): Promise<string> {
    await mkdir(this.root, { recursive: true });
    if ((await lstat(this.root)).isSymbolicLink()) fail("worktree_path_unsafe", "managed worktree root cannot be a symlink");
    const root = await realpath(this.root);
    if (/[\r\n]/.test(root)) fail("worktree_path_unsafe", "managed root cannot contain line breaks");
    if (worktreePathsEqual(root, sourceRoot) || worktreePathIsWithin(sourceRoot, root)
      || worktreePathIsWithin(root, sourceRoot) || worktreePathsEqual(root, commonDir) || worktreePathIsWithin(commonDir, root)) {
      fail("worktree_path_unsafe", "managed worktree root overlaps the source repository");
    }
    return root;
  }
  private expectedPath(run: ConversationWorktreeRun, id: string): string { return join(realpathSync(this.root), run.repositoryIdentity, digest(run.runId), id); }
  private newResource(run: ConversationWorktreeRun, botId: string, kind: "member" | "integration"): ConversationWorktreeResource {
    const id = digest(`${kind}\0${run.runId}\0${botId}`);
    return { id, botId, kind, generation: 1, branchRef: `refs/heads/xacpx/10c/${digest(run.runId)}/${id}`,
      worktreePath: this.expectedPath(run, id), ownerToken: `xacpx-conversation:${randomUUID()}`, state: "planned", createdAt: now(), updatedAt: now() };
  }
  private requireRun(id: string): ConversationWorktreeRun {
    return this.registry.get(id) ?? fail("worktree_unprovisioned", "Run has no accepted worktree base contract");
  }
  async prepare(runId: string, botId: string, fence: () => void): Promise<ConversationWorktreeRef> {
    return this.exclusive(runId, async () => {
      fence(); let run = this.requireRun(runId);
      if (run.disposition !== "pending" || run.integration) fail("worktree_run_closed", "Run no longer accepts member execution");
      let resource = run.resources.find(r => r.kind === "member" && r.botId === botId);
      if (!resource) { resource = this.newResource(run, botId, "member"); run.resources.push(resource); run = this.registry.save(run); }
      await this.provision(run, resource.id, fence);
      return { runId, worktreeId: resource.id, generation: resource.generation };
    });
  }
  async provision(run: ConversationWorktreeRun, id: string, fence: () => void = () => {}): Promise<void> {
    let r = run.resources.find(r => r.id === id)!;
    if (!["planned", "provisioning", "provision-failed"].includes(r.state)) { await this.verify(run, r); fence(); return; }
    r.state = "provisioning"; run = this.registry.save(run); r = run.resources.find(r => r.id === id)!;
    await this.checkpoint("intent-persisted", run.runId);
    try {
      fence(); await this.assertRepository(run); await this.managedRoot(run.sourceRoot, run.commonDir);
      let parent = await realpath(this.root);
      for (const segment of [run.repositoryIdentity, digest(run.runId)]) {
        parent = join(parent, segment); await mkdir(parent, { recursive: true });
        const stat = await lstat(parent);
        if (stat.isSymbolicLink() || !stat.isDirectory() || !worktreePathIsWithin(await realpath(this.root), await realpath(parent))) fail("worktree_path_unsafe", "unsafe managed path component");
      }
      if (!existsSync(r.worktreePath)) {
        fence(); await this.checkpoint("before-add", run.runId);
        await this.git(run.sourceRoot, ["worktree", "add", "--lock", "--reason", r.ownerToken, "-b", r.branchRef.slice(11), r.worktreePath, run.baseCommitSha]);
        await this.checkpoint("after-add", run.runId);
      }
      r.gitDir = await realpath((await this.git(r.worktreePath, ["rev-parse", "--absolute-git-dir"])).trim());
      await this.verify(run, r);
      // Preserve verified ownership even if cancellation wins the readiness
      // fence. Teardown must be able to safely remove a never-started tree.
      run = this.registry.save(run); r = run.resources.find(v => v.id === id)!;
      fence();
      r.state = "ready"; r.updatedAt = now(); delete r.lastError; this.registry.save(run);
      await this.checkpoint("ready-persisted", run.runId);
    } catch (error) {
      // Keep the intent and any created directory. No compensation can discard work.
      const current = this.requireRun(run.runId); const owned = current.resources.find(v => v.id === id)!;
      owned.state = "provision-failed"; owned.lastError = errorText(error); owned.updatedAt = now();
      this.registry.save(current); throw error;
    }
  }
  private async assertRepository(run: ConversationWorktreeBase): Promise<void> {
    const configured = this.config.workspaces[run.workspace];
    if (!configured || run.repositoryIdentity !== digest(process.platform === "win32" ? run.commonDir.toLowerCase() : run.commonDir)
      || !worktreePathsEqual(await realpath(configured.cwd), run.sourceRoot)
      || !worktreePathsEqual(await realpath((await this.git(run.sourceRoot, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).trim()), run.commonDir)) {
      fail("worktree_repository_drift", "registered repository no longer matches the accepted Run");
    }
    await this.git(run.sourceRoot, ["cat-file", "-e", `${run.baseCommitSha}^{commit}`]);
  }
  private verifyFiles(run: ConversationWorktreeRun, r: ConversationWorktreeResource, allowUnlocked = false): void {
    if (r.id !== digest(`${r.kind}\0${run.runId}\0${r.botId}`) || r.branchRef !== `refs/heads/xacpx/10c/${digest(run.runId)}/${r.id}`
      || !worktreePathsEqual(r.worktreePath, this.expectedPath(run, r.id)) || lstatSync(r.worktreePath).isSymbolicLink()
      || !worktreePathsEqual(realpathSync(r.worktreePath), r.worktreePath) || !r.gitDir
      || !worktreePathIsWithin(join(run.commonDir, "worktrees"), realpathSync(r.gitDir))) fail("worktree_identity_mismatch", "worktree path or Git directory changed");
    const pointer = readFileSync(join(r.worktreePath, ".git"), "utf8").trim();
    if (!pointer.startsWith("gitdir: ") || !worktreePathsEqual(realpathSync(resolve(r.worktreePath, pointer.slice(8))), r.gitDir)
      || !worktreePathsEqual(realpathSync(resolve(r.gitDir, readFileSync(join(r.gitDir, "commondir"), "utf8").trim())), run.commonDir)
      || !worktreePathsEqual(realpathSync(readFileSync(join(r.gitDir, "gitdir"), "utf8").trim()), join(r.worktreePath, ".git"))
      || this.currentBranch(r.worktreePath) !== r.branchRef
      || (!allowUnlocked && readFileSync(join(r.gitDir, "locked"), "utf8").trim() !== r.ownerToken)
      || (allowUnlocked && existsSync(join(r.gitDir, "locked")) && readFileSync(join(r.gitDir, "locked"), "utf8").trim() !== r.ownerToken)) {
      fail("worktree_identity_mismatch", "worktree registration, branch or owner token changed");
    }
  }
  async verify(run: ConversationWorktreeRun, r: ConversationWorktreeResource, allowUnlocked = false): Promise<void> {
    await this.assertRepository(run); this.verifyFiles(run, r, allowUnlocked);
    const registration = (await this.git(run.sourceRoot, ["-c", "core.quotePath=false", "worktree", "list", "--porcelain"])).split(/\r?\n\r?\n/)
      .find(block => block.split(/\r?\n/).some(line => line.startsWith("worktree ") && worktreePathsEqual(line.slice(9), r.worktreePath)));
    if (!registration || !registration.split(/\r?\n/).includes(`branch ${r.branchRef}`)) fail("worktree_identity_mismatch", "worktree is not registered to its durable owner");
    await this.git(r.worktreePath, ["merge-base", "--is-ancestor", run.baseCommitSha, "HEAD"]);
  }
  resolveSessionCwd(session: LogicalSession): string {
    const ref = session.execution_worktree;
    if (!ref) fail("worktree_identity_mismatch", "missing session worktree binding");
    const run = this.requireRun(ref.runId), r = run.resources.find(r => r.id === ref.worktreeId);
    const configured = this.config.workspaces[run.workspace];
    if (!configured || !worktreePathsEqual(realpathSync(configured.cwd), run.sourceRoot)
      || !worktreePathsEqual(realpathSync(run.commonDir), run.commonDir)) fail("worktree_repository_drift", "session repository binding changed");
    if (!r || r.kind !== "member" || r.generation !== ref.generation || session.owner?.kind !== "group-member"
      || session.owner.botId !== r.botId || session.owner.conversationId !== run.conversationId || session.owner.topicId !== run.topicId
      || session.workspace !== run.workspace || !["ready", "active", "awaiting-integration"].includes(r.state)) fail("worktree_identity_mismatch", "session does not own a runnable worktree");
    this.verifyFiles(run, r); return r.worktreePath;
  }
  async verifyReference(ref: ConversationWorktreeRef): Promise<string> {
    const run = this.requireRun(ref.runId), r = run.resources.find(r => r.id === ref.worktreeId);
    if (!r || r.generation !== ref.generation || !["ready", "active", "awaiting-integration"].includes(r.state)) fail("worktree_identity_mismatch", "worktree is unavailable for execution");
    await this.verify(run, r); return r.worktreePath;
  }
  async mark(ref: ConversationWorktreeRef, state: "active" | "awaiting-integration"): Promise<void> {
    await this.exclusive(ref.runId, async () => {
      const run = this.requireRun(ref.runId), r = run.resources.find(r => r.id === ref.worktreeId)!;
      if (!r || r.generation !== ref.generation) fail("worktree_identity_mismatch", "worktree generation changed");
      if (!["ready", "active", "awaiting-integration"].includes(r.state)) return;
      r.state = state; r.updatedAt = now(); this.registry.save(run);
    });
  }
  async reconcile(): Promise<void> {
    for (const initial of this.registry.list()) await this.exclusive(initial.runId, async () => {
      for (const id of initial.resources.filter(r => r.state !== "cleaned").map(r => r.id)) {
        let run = this.requireRun(initial.runId); const r = run.resources.find(r => r.id === id)!;
        try {
          if (["planned", "provisioning", "provision-failed"].includes(r.state)) { await this.provision(run, id); continue; }
          if (r.state === "cleanup-pending" || r.state === "cleanup-failed") continue; // cleanup requires physical-release proof
          await this.verify(run, r);
          if (r.state === "active") { r.state = "awaiting-integration"; this.registry.save(run); }
        } catch (e) {
          run = this.requireRun(initial.runId); const current = run.resources.find(r => r.id === id)!;
          current.state = existsSync(current.worktreePath) ? "recovery-required" : "missing"; current.lastError = errorText(e); this.registry.save(run);
        }
      }
      const run = this.requireRun(initial.runId);
      if (run.integration && ["preparing", "integrating"].includes(run.integration.state)) {
        run.integration.state = "recovery-required";
        run.integration.lastError = "interrupted integration requires explicit Git evidence reconciliation";
        this.registry.save(run);
      }
      try {
        const diagnostic = this.requireRun(initial.runId);
        const known = this.registry.list().flatMap(r => r.resources.map(m => m.worktreePath));
        const blocks = (await this.git(run.sourceRoot, ["-c", "core.quotePath=false", "worktree", "list", "--porcelain"])).split(/\r?\n\r?\n/);
        diagnostic.orphanWorktreePaths = blocks.map(b => b.split(/\r?\n/).find(l => l.startsWith("worktree "))?.slice(9))
          .filter((p): p is string => !!p && worktreePathIsWithin(realpathSync(this.root), p) && !known.some(k => worktreePathsEqual(k, p)));
        this.registry.save(diagnostic);
      } catch { /* resource errors above remain durable; unavailable repositories cannot authorize cleanup */ }
    });
  }
  async assertSupportedTree(cwd: string): Promise<void> {
    const staged = await this.git(cwd, ["ls-files", "--stage", "-z"]);
    if (staged.split("\0").some(line => line.startsWith("160000 "))) fail("worktree_unsupported_tree", "submodules require a separate lifecycle contract");
    let sparse = ""; try { sparse = (await this.git(cwd, ["config", "--get", "core.sparseCheckout"])).trim(); } catch { /* absent is false */ }
    if (sparse === "true") fail("worktree_unsupported_tree", "sparse worktrees are unsupported");
    const paths = (await this.git(cwd, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"])).split("\0").filter(Boolean);
    for (let n = 0; n < paths.length; n += 32) {
      const attrs = (await this.git(cwd, ["check-attr", "-z", "filter", "merge", "--", ...paths.slice(n, n + 32)])).split("\0");
      for (let k = 0; k + 2 < attrs.length; k += 3) if ((attrs[k + 1] === "filter" && !["unspecified", "unset"].includes(attrs[k + 2]!))
        || (attrs[k + 1] === "merge" && !["unspecified", "unset", "set", "text", "binary"].includes(attrs[k + 2]!))) fail("worktree_unsupported_tree", "custom Git filters/merge drivers are not supported for managed snapshots");
    }
  }
  async capture(run: ConversationWorktreeRun, r: ConversationWorktreeResource): Promise<WorktreePreviewMember> {
    await this.verify(run, r); await this.assertSupportedTree(r.worktreePath);
    const head = (await this.git(r.worktreePath, ["rev-parse", "HEAD"])).trim();
    const indexRoot = join(await this.managedRoot(run.sourceRoot, run.commonDir), ".indexes");
    await mkdir(indexRoot, { recursive: true });
    if ((await lstat(indexRoot)).isSymbolicLink()) fail("worktree_path_unsafe", "snapshot index directory is a symlink");
    const directory = await mkdtemp(join(indexRoot, "snapshot-")); const index = join(directory, "index");
    const env = { GIT_INDEX_FILE: index };
    try {
      await this.git(r.worktreePath, ["read-tree", head], env);
      await this.git(r.worktreePath, ["add", "-A", "--", "."], env);
      const tree = (await this.git(r.worktreePath, ["write-tree"], env)).trim();
      if ((await this.git(r.worktreePath, ["ls-tree", "-r", tree])).split("\n").some(line => line.startsWith("160000 "))) fail("worktree_unsupported_tree", "snapshot contains an unmanaged nested repository");
      const files = (await this.git(r.worktreePath, ["diff", "--name-only", "-z", run.baseCommitSha, tree])).split("\0").filter(Boolean);
      const preview = await runWorkspaceGitPreview(r.worktreePath,
        [...safeGit, "diff", "--no-ext-diff", "--no-textconv", "--stat", "--patch", run.baseCommitSha, tree], this.gitEnvironment())
        .catch(error => { throw new ConversationError("worktree_git_failed", errorText(error)); });
      const diff = preview.truncated ? preview.stdout.slice(0, 32_700).replace(/[\uD800-\uDBFF]$/, "")
        + "\n[Preview truncated; inspect the member worktree for the full diff.]" : preview.stdout;
      return { botId: r.botId, worktreeId: r.id, head, tree, files, diff };
    } finally {
      await unlink(index).catch(() => {});
      await rmdir(directory).catch(() => {}); // exact owned directory, empty only; never recursively delete
    }
  }
  async cleanup(runId: string): Promise<ConversationWorktreeRun> {
    return this.exclusive(runId, async () => {
      let run = this.requireRun(runId);
      for (const id of run.resources.filter(r => r.state !== "cleaned").map(r => r.id)) {
        run = this.requireRun(runId); const r = run.resources.find(r => r.id === id)!;
        const interrupted = r.state === "cleanup-pending" || r.state === "cleanup-failed";
        try {
          if (interrupted && !existsSync(r.worktreePath)) {
            const listed = await this.git(run.sourceRoot, ["-c", "core.quotePath=false", "worktree", "list", "--porcelain"]);
            if (listed.split(/\r?\n/).some(line => line.startsWith("worktree ") && worktreePathsEqual(line.slice(9), r.worktreePath))) fail("worktree_cleanup_unsafe", "missing path still has a Git owner");
            r.state = "cleaned"; this.registry.save(run); continue;
          }
          await this.verify(run, r, interrupted);
          const dirty = await this.git(r.worktreePath, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignored"]);
          const head = (await this.git(r.worktreePath, ["rev-parse", "HEAD"])).trim();
          const integrated = run.disposition === "integrated" && (r.kind === "integration" ? run.integration?.candidateCommitSha === head : r.snapshotSha === head);
          if (dirty || (!integrated && head !== run.baseCommitSha) || run.integration?.state === "conflicted"
            || (run.disposition === "abandoned" && r.kind === "integration")) fail("worktree_cleanup_unsafe", "unintegrated, dirty or conflicted worktree must be retained");
          r.state = "cleanup-pending"; run = this.registry.save(run);
          await this.checkpoint("before-remove", runId);
          await this.verify(run, r, true);
          if (existsSync(join(r.gitDir!, "locked"))) await this.git(run.sourceRoot, ["worktree", "unlock", r.worktreePath]);
          await this.git(run.sourceRoot, ["worktree", "remove", r.worktreePath]);
          await this.checkpoint("after-remove", runId);
          const removed = run.resources.find(v => v.id === id)!;
          removed.state = "cleaned"; removed.updatedAt = now(); this.registry.save(run);
        } catch (e) {
          run = this.requireRun(runId); const current = run.resources.find(r => r.id === id)!;
          current.state = "cleanup-failed"; current.lastError = errorText(e); this.registry.save(run); throw e;
        }
      }
      return this.requireRun(runId);
    });
  }
  createIntegrationResource(run: ConversationWorktreeRun, id: string): ConversationWorktreeResource {
    return this.newResource(run, id, "integration");
  }
}
