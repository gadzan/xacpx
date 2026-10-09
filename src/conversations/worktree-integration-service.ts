import { randomUUID } from "node:crypto";
import type { AppState } from "../state/types";
import type { BotRuntimeManager } from "../bots/bot-runtime-manager";
import type { ReleaseOwnedSession } from "../sessions/owned-session-release";
import { ConversationError } from "./conversation-error";
import type { SqliteConversationStore } from "./sqlite-conversation-store";
import type { ConversationWorktreeManager } from "./conversation-worktree-manager";
import { parseWorktreeOperation, type ConversationWorktreeRun, type WorktreeOperation } from "./conversation-worktree-types";

const stamp = (): string => new Date().toISOString();
function fail(code: string, message: string): never { throw new ConversationError(code, message); }
const details = (e: unknown): string => (e instanceof Error ? e.message : String(e)).slice(0, 8192);

/** Explicit human Git operations. No dispatcher/model entry point calls this service. */
export class WorktreeIntegrationService {
  constructor(private readonly manager: ConversationWorktreeManager, private readonly store: SqliteConversationStore,
    private readonly state: AppState, private readonly runtime: BotRuntimeManager, private readonly release: ReleaseOwnedSession) {}
  private require(id: string): ConversationWorktreeRun {
    return this.store.worktrees.get(id) ?? fail("worktree_unprovisioned", "Run has no worktree registry");
  }
  private assertSettled(id: string): void {
    const run = this.store.getRun(id);
    // A completed teardown may retain an audit registry, but never live sessions.
    if (!run) return;
    if (!["completed", "failed", "cancelled"].includes(run.state)
      || this.store.listMemberTurns(id).some(m => ["running", "dispatched", "indeterminate"].includes(m.state))) {
      fail("worktree_run_not_settled", "settle or reconcile the Run before integration/cleanup");
    }
  }
  private async quiesce(id: string): Promise<void> {
    this.assertSettled(id);
    const run = this.require(id);
    for (const binding of Object.values(this.state.bot_runtime_bindings)) if (binding.scope === "group-member"
      && binding.conversationId === run.conversationId && binding.topicId === run.topicId) {
      // A successor Run cannot exist while disposition is pending. After
      // integration/abandonment only release sessions belonging to this Run.
      if (this.state.sessions[binding.sessionAlias]?.execution_worktree?.runId === id) await this.runtime.releaseGroupMemberBinding(binding.id);
    }
    for (const session of Object.values(this.state.sessions)) if (session.execution_worktree?.runId === id) {
      if (session.owner?.kind !== "group-member" || session.owner.conversationId !== run.conversationId || session.owner.topicId !== run.topicId) {
        fail("worktree_identity_mismatch", "cannot release a contradictory worktree session owner");
      }
      await this.release(session.alias);
    }
    this.assertSettled(id);
    if (Object.values(this.state.sessions).some(s => s.execution_worktree?.runId === id)) fail("worktree_session_live", "worktree still has a physical session owner");
  }
  async operate(value: WorktreeOperation): Promise<ConversationWorktreeRun> {
    const input = parseWorktreeOperation(value);
    await this.quiesce(input.runId); // Bot gates always precede the resource lock.
    if (input.action === "cleanup") return this.manager.cleanup(input.runId);
    if (input.action === "recover" && !this.require(input.runId).integration) { await this.manager.reconcile(); return this.require(input.runId); }
    return this.manager.exclusive(input.runId, async () => {
      let run = this.require(input.runId);
      this.assertSettled(input.runId);
      if (input.action === "preview") {
        if (run.disposition !== "pending" || run.integration) fail("worktree_integration_conflict", "Run already has an integration decision");
        const members = run.resources.filter(r => r.kind === "member");
        if (input.botIds.length !== members.length || input.botIds.some(id => !members.some(r => r.botId === id))) {
          fail("worktree_selection_conflict", "integration must name the complete provisioned member set exactly once");
        }
        const captured = [];
        for (const id of input.botIds) captured.push(await this.manager.capture(run, members.find(r => r.botId === id)!));
        run.preview = { id: randomUUID(), createdAt: stamp(), members: captured };
        return this.store.worktrees.save(run);
      }
      if (input.action === "abandon") {
        if (run.disposition === "integrated") fail("worktree_integration_conflict", "integrated candidate cannot be abandoned");
        run.disposition = "abandoned";
        if (run.integration) run.integration.state = "abandoned";
        return this.store.worktrees.save(run); // preserve every source and conflict file
      }
      if (input.action === "integrate") {
        if (run.integration) {
          if (run.integration.requestId !== input.requestId || run.integration.previewId !== input.previewId) fail("worktree_integration_conflict", "integration request already has another frozen identity");
          return run;
        }
        if (run.disposition !== "pending" || !run.preview || run.preview.id !== input.previewId) fail("worktree_preview_stale", "preview this Run before authorizing snapshots");
        for (const preview of run.preview.members) {
          const resource = run.resources.find(r => r.id === preview.worktreeId)!;
          const current = await this.manager.capture(run, resource);
          if (current.head !== preview.head || current.tree !== preview.tree) fail("worktree_preview_stale", "member changes differ from the authorized preview");
          resource.snapshotParent = preview.head; resource.snapshotTree = preview.tree;
        }
        const id = randomUUID(); const resource = this.manager.createIntegrationResource(run, id);
        run.resources.push(resource);
        run.integration = { id, generation: 1, operationSource: "control", requestId: input.requestId, previewId: input.previewId, state: "preparing", resourceId: resource.id,
          orderedBotIds: run.preview.members.map(m => m.botId), patches: [], nextIndex: 0,
          candidateCommitSha: run.baseCommitSha, conflictFiles: [], createdAt: stamp(), updatedAt: stamp() };
        run = this.store.worktrees.save(run); // authorization and intent precede every commit
        return this.advance(run, false);
      }
      if (!run.integration) fail("worktree_integration_missing", "no integration intent exists");
      if (["integrated", "abandoned"].includes(run.integration.state)) return run;
      return this.advance(run, input.action === "continue");
    });
  }
  private environment(run: ConversationWorktreeRun): NodeJS.ProcessEnv {
    return { GIT_AUTHOR_NAME: "xacpx integration", GIT_AUTHOR_EMAIL: "integration@xacpx.invalid",
      GIT_COMMITTER_NAME: "xacpx integration", GIT_COMMITTER_EMAIL: "integration@xacpx.invalid",
      GIT_AUTHOR_DATE: run.integration!.createdAt, GIT_COMMITTER_DATE: run.integration!.createdAt,
      GIT_EDITOR: "true", GIT_SEQUENCE_EDITOR: "true", GIT_MERGE_AUTOEDIT: "no" };
  }
  private async advance(initial: ConversationWorktreeRun, continueConflict: boolean): Promise<ConversationWorktreeRun> {
    let run = initial;
    try {
      const env = this.environment(run);
      for (const botId of run.integration!.orderedBotIds) {
        const r = run.resources.find(r => r.kind === "member" && r.botId === botId)!;
        if (r.patchSha) continue;
        await this.manager.verify(run, r);
        if (!r.snapshotTree || !r.snapshotParent) fail("worktree_registry_corrupt", "snapshot authorization lost its immutable tree/parent");
        const snapshot = (await this.manager.git(r.worktreePath, ["commit-tree", r.snapshotTree, "-p", r.snapshotParent,
          "-m", `xacpx member snapshot ${run.integration!.id} ${r.id}`], env)).trim();
        const patch = (await this.manager.git(r.worktreePath, ["commit-tree", r.snapshotTree, "-p", run.baseCommitSha,
          "-m", `xacpx integration source ${run.integration!.id} ${r.id}`], env)).trim();
        const head = (await this.manager.git(r.worktreePath, ["rev-parse", "HEAD"])).trim();
        const captured = await this.manager.capture(run, r);
        if (![r.snapshotParent, snapshot].includes(head) || captured.tree !== r.snapshotTree) fail("worktree_preview_stale", "member changed during snapshot publication");
        const prefix = `refs/xacpx/conversations/${r.id}/${run.integration!.id}`;
        await this.manager.git(run.sourceRoot, ["update-ref", `${prefix}/snapshot`, snapshot]);
        await this.manager.git(run.sourceRoot, ["update-ref", `${prefix}/patch`, patch]);
        if (head !== snapshot) await this.manager.git(r.worktreePath, ["update-ref", r.branchRef, snapshot, r.snapshotParent]);
        await this.manager.checkpoint("after-snapshot-ref", run.runId);
        // Publication updates only Git's index, never overwrites workspace files.
        await this.manager.git(r.worktreePath, ["read-tree", r.snapshotTree]);
        await this.manager.checkpoint("after-snapshot-index", run.runId);
        r.snapshotSha = snapshot; r.patchSha = patch;
        run = this.store.worktrees.save(run);
      }
      run.integration!.patches = run.integration!.orderedBotIds.map(id => run.resources.find(r => r.kind === "member" && r.botId === id)!.patchSha!);
      run = this.store.worktrees.save(run);
      await this.manager.provision(run, run.integration!.resourceId);
      run = this.require(run.runId);
      const candidate = run.resources.find(r => r.id === run.integration!.resourceId)!;
      await this.manager.verify(run, candidate);
      while (run.integration!.nextIndex < run.integration!.patches.length) {
        const i = run.integration!; const patch = i.patches[i.nextIndex]!;
        const head = (await this.manager.git(candidate.worktreePath, ["rev-parse", "HEAD"])).trim();
        if (i.expectedParent) {
          if (head !== i.expectedParent) {
            const parents = (await this.manager.git(candidate.worktreePath, ["rev-list", "--parents", "-n", "1", "HEAD"])).trim().split(" ");
            const message = await this.manager.git(candidate.worktreePath, ["log", "-1", "--format=%B"]);
            if (parents.length !== 2 || parents[1] !== i.expectedParent || !message.includes(`(cherry picked from commit ${patch})`)
              || (await this.manager.git(candidate.worktreePath, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]))) {
              fail("worktree_integration_ambiguous", "candidate HEAD does not prove the pending integration step");
            }
            i.candidateCommitSha = head; i.nextIndex++; delete i.expectedParent; i.conflictFiles = []; i.state = "integrating";
            run = this.store.worktrees.save(run); continue;
          }
          let pending = ""; try { pending = (await this.manager.git(candidate.worktreePath, ["rev-parse", "--verify", "CHERRY_PICK_HEAD"])).trim(); } catch { /* no pending pick */ }
          if (pending) {
            if (pending !== patch) fail("worktree_integration_ambiguous", "another cherry-pick owns the candidate");
            const conflicts = (await this.manager.git(candidate.worktreePath, ["diff", "--name-only", "--diff-filter=U", "-z"])).split("\0").filter(Boolean);
            if (conflicts.length || !continueConflict) { i.state = "conflicted"; i.conflictFiles = conflicts; return this.store.worktrees.save(run); }
            let empty = false;
            try { await this.manager.git(candidate.worktreePath, ["diff", "--cached", "--quiet"]); empty = true; } catch { /* staged changes */ }
            if (empty) {
              const message = (await this.manager.git(candidate.worktreePath, ["log", "-1", "--format=%B", patch])).trim();
              await this.manager.git(candidate.worktreePath, ["commit", "--allow-empty", "--no-verify", "-m", `${message}\n\n(cherry picked from commit ${patch})`], env);
            } else await this.manager.git(candidate.worktreePath, ["-c", "core.editor=true", "cherry-pick", "--continue"], env);
            await this.manager.checkpoint("after-pick", run.runId);
            continue; // inspect exact evidence before committing the cursor
          }
          if (await this.manager.git(candidate.worktreePath, ["status", "--porcelain=v1", "-z", "--untracked-files=all"])) {
            fail("worktree_integration_ambiguous", "candidate changed without matching cherry-pick evidence");
          }
        } else {
          if (head !== i.candidateCommitSha || (await this.manager.git(candidate.worktreePath, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]))) {
            fail("worktree_integration_ambiguous", "candidate differs from its durable integration cursor");
          }
          i.state = "integrating"; i.expectedParent = head; i.updatedAt = stamp(); run = this.store.worktrees.save(run);
        }
        try {
          await this.manager.git(candidate.worktreePath, ["cherry-pick", "-x", "--allow-empty", "--keep-redundant-commits", patch], env);
          await this.manager.checkpoint("after-pick", run.runId);
        } catch (error) {
          const conflicts = (await this.manager.git(candidate.worktreePath, ["diff", "--name-only", "--diff-filter=U", "-z"])).split("\0").filter(Boolean);
          if (!conflicts.length) throw error;
          run.integration!.state = "conflicted"; run.integration!.conflictFiles = conflicts; run.integration!.lastError = details(error);
          return this.store.worktrees.save(run);
        }
      }
      run.disposition = "integrated"; run.integration!.state = "integrated"; run.integration!.updatedAt = stamp();
      for (const r of run.resources) r.state = "integrated";
      return this.store.worktrees.save(run);
    } catch (error) {
      const current = this.require(run.runId);
      current.integration!.state = "recovery-required"; current.integration!.lastError = details(error);
      this.store.worktrees.save(current); throw error;
    }
  }
  async cleanupScope(conversationId: string, topicId?: string): Promise<void> {
    for (const run of this.store.worktrees.list(conversationId, topicId)) {
      // Teardown already owns Bot gates and has strictly released sessions.
      this.assertSettled(run.runId);
      if (Object.values(this.state.sessions).some(s => s.execution_worktree?.runId === run.runId)) fail("worktree_session_live", "cannot remove an owned live worktree");
      await this.manager.cleanup(run.runId);
    }
  }
}
