import { expect, test } from "bun:test";
import { mkdtemp, writeFile, readFile, readdir, rename, symlink, unlink, mkdir, chmod } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { runWorkspaceGit, runWorkspaceGitPreview, runWorkspaceGitSync } from "../../../src/control/workspace-git";
import { harness, deferred, HUMAN } from "./fixtures/concurrency-harness";
import { SqliteConversationStore } from "../../../src/conversations/sqlite-conversation-store";
import { ConversationWorktreeManager } from "../../../src/conversations/conversation-worktree-manager";
import { WorktreeIntegrationService } from "../../../src/conversations/worktree-integration-service";
import { createSqlDriver } from "../../../src/conversations/sql-driver";
import { worktreeStatus } from "../../../src/conversations/conversation-worktree-types";
import { AcpxCliTransport } from "../../../src/transport/acpx-cli/acpx-cli-transport";
import { resolveAcpxCommand } from "../../../src/config/resolve-acpx-command";
import { RuntimeEngine } from "../../../src/bridge/engine/runtime-engine";
import { GroupHandoffService } from "../../../src/conversations/group-handoff";
import { parseState } from "../../../src/state/state-store";

async function gitFixture(options: Parameters<typeof harness>[0] = {}, refFormat?: "reftable") {
  const dir = await mkdtemp(join(tmpdir(), "xacpx-10c-")), source = join(dir, "source");
  await runWorkspaceGit(dir, ["init", ...(refFormat ? [`--ref-format=${refFormat}`] : []), "--initial-branch=main", source]);
  await runWorkspaceGit(source, ["config", "core.autocrlf", "false"]);
  await writeFile(join(source, "same.txt"), "first\nsecond\nthird\n");
  await runWorkspaceGit(source, ["add", "."]);
  await runWorkspaceGit(source, ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "base"]);
  const h = await harness({ ...options, workspaceCwd: source, worktreeRoot: join(dir, "managed") });
  const g = await h.bots.createGroup({ title: "Worktrees", botIds: h.ids });
  const topic = await h.service.createGroupTopic(g.id, "Isolated", { workspace: "backend", isolation: "worktree-per-member" }, { maxConcurrentMemberTurns: 2 });
  const accept = (id = "request", count = 2) => h.service.acceptGroupPrompt({ conversationId: g.id, topicId: topic.id, requestId: id,
    text: "modify independently", target: { mode: "members", botIds: h.ids.slice(0, count) }, humanIngress: HUMAN });
  return { ...h, dir, source, topic, g, accept };
}
async function wait(check: () => boolean) {
  const end = Date.now() + 20_000; while (!check()) { if (Date.now() > end) throw new Error("worktree execution timed out"); await new Promise(r => setTimeout(r, 5)); }
}

test("two real member writers have separate verified cwd and refill within capacity; main stays unchanged", async () => {
  const h = await gitFixture(); const accepted = await h.accept("writers", 3);
  const original = accepted.memberTurns.map(m => [m.id, m.batch, m.effect, m.origin]);
  const drain = h.dispatcher.kick();
  await wait(() => h.runner.calls.length === 2);
  const cwd = h.runner.calls.map(c => h.sessions.getResolvedSessionByInternalAlias(c.sessionAlias)!.cwd);
  expect(cwd[0]).not.toBe(cwd[1]); expect(cwd).not.toContain(h.source);
  await writeFile(join(cwd[0]!, "same.txt"), "member A\n"); await writeFile(join(cwd[1]!, "same.txt"), "member B\n");
  expect(await readFile(join(cwd[0]!, "same.txt"), "utf8")).toBe("member A\n");
  expect(await readFile(join(h.source, "same.txt"), "utf8")).toBe("first\nsecond\nthird\n");
  h.runner.finish(0); await wait(() => h.runner.calls.length === 3);
  expect(h.runner.peak).toBe(2); h.runner.finish(1); h.runner.finish(2); await drain;
  expect(h.store.getRun(accepted.run.id)?.state).toBe("completed");
  expect(h.store.listMemberTurns(accepted.run.id).map(m => [m.id, m.batch, m.effect, m.origin])).toEqual(original);
  expect(h.runner.calls.every(c => c.executionOrigin === "human")).toBe(true);
  const registry = h.store.worktrees.get(accepted.run.id)!;
  expect(registry.resources).toHaveLength(3);
  for (const r of registry.resources) expect((await h.worktrees!.git(r.worktreePath, ["merge-base", "HEAD", registry.baseCommitSha])).trim()).toBe(registry.baseCommitSha);
  await expect(h.accept("successor")).rejects.toMatchObject({ code: "worktree_integration_pending" });
  h.store.close();
}, 60_000);

for (const point of ["intent-persisted", "before-add", "after-add", "ready-persisted"]) {
  test(`durable provisioning recovers failure at ${point} without adopting another owner`, async () => {
    let injected = false;
    const h = await gitFixture({ worktreeHooks: { checkpoint: async at => { if (at === point && !injected) { injected = true; throw new Error("crash"); } } } });
    const a = await h.accept();
    await expect(h.worktrees!.prepare(a.run.id, h.ids[0]!, () => {})).rejects.toThrow("crash");
    await h.worktrees!.reconcile();
    const ref = await h.worktrees!.prepare(a.run.id, h.ids[0]!, () => {});
    const path = await h.worktrees!.verifyReference(ref);
    expect(h.store.worktrees.get(a.run.id)?.resources).toHaveLength(1);
    expect(await h.worktrees!.prepare(a.run.id, h.ids[0]!, () => {})).toEqual(ref);
    expect(path).not.toBe(h.source); h.store.close();
  }, 60_000);
}

test("dirty source is rejected before Run persistence", async () => {
  const h = await gitFixture(); await writeFile(join(h.source, "untracked.txt"), "do not discard");
  await expect(h.accept()).rejects.toMatchObject({ code: "worktree_workspace_dirty" });
  expect(h.store.listRuns(h.g.id, h.topic.id)).toHaveLength(0); h.store.close();
}, 30_000);

test("cancel during Git provisioning fences provider admission and releases unused capacity", async () => {
  const gate = deferred(), entered = deferred();
  const h = await gitFixture({ worktreeHooks: { checkpoint: async point => { if (point === "after-add") { entered.resolve(); await gate.promise; } } } });
  const a = await h.accept(); const drain = h.dispatcher.kick(); await entered.promise;
  const cancelling = h.service.cancelRun(a.run.id); gate.resolve(); await cancelling; await drain;
  expect(h.runner.calls).toHaveLength(0); expect(h.store.getRun(a.run.id)?.state).toBe("cancelled");
  expect(h.store.listMemberTurns(a.run.id).every(m => m.state === "cancelled")).toBe(true); h.store.close();
}, 60_000);

test("missing worktree and changed Git ownership fail closed with zero provider calls", async () => {
  const h = await gitFixture(); const a = await h.accept("drift", 1); const ref = await h.worktrees!.prepare(a.run.id, h.ids[0]!, () => {});
  const r = h.store.worktrees.get(a.run.id)!.resources[0]!;
  await writeFile(join(r.gitDir!, "locked"), "another owner");
  await expect(h.worktrees!.verifyReference(ref)).rejects.toThrow();
  await h.dispatcher.kick(); expect(h.runner.calls).toHaveLength(0); h.store.close();
}, 60_000);

async function settledFixture(changes: [string, string]) {
  const h = await gitFixture(); const a = await h.accept(); const drain = h.dispatcher.kick();
  await wait(() => h.runner.calls.length === 2);
  for (let i = 0; i < 2; i++) { const c = h.runner.calls[i]!; const cwd = h.sessions.getResolvedSessionByInternalAlias(c.sessionAlias)!.cwd;
    await writeFile(join(cwd, "same.txt"), changes[i]!); h.runner.finish(i); }
  await drain; return { ...h, accepted: a };
}

test("explicit snapshots integrate nonconflicting results into a candidate and safely clean only owned worktrees", async () => {
  const h = await settledFixture(["changed first\nsecond\nthird\n", "first\nsecond\nchanged third\n"]);
  let r = await h.integrations!.operate({ action: "preview", runId: h.accepted.run.id, botIds: h.ids.slice(0, 2) });
  expect(r.preview!.members).toHaveLength(2);
  r = await h.integrations!.operate({ action: "integrate", runId: r.runId, requestId: "integration", previewId: r.preview!.id, snapshotUncommitted: true });
  expect(r.integration!.state).toBe("integrated");
  const candidate = r.resources.find(r => r.kind === "integration")!;
  expect(await readFile(join(candidate.worktreePath, "same.txt"), "utf8")).toBe("changed first\nsecond\nchanged third\n");
  expect(await readFile(join(h.source, "same.txt"), "utf8")).toBe("first\nsecond\nthird\n");
  const replay = await h.integrations!.operate({ action: "integrate", runId: r.runId, requestId: "integration", previewId: r.preview!.id, snapshotUncommitted: true });
  expect(replay.integration!.candidateCommitSha).toBe(r.integration!.candidateCommitSha);
  r = await h.integrations!.operate({ action: "cleanup", runId: r.runId }); expect(r.resources.every(r => r.state === "cleaned")).toBe(true);
  const next = await h.accept("next"); expect(next.run.id).not.toBe(r.runId); h.store.close();
}, 90_000);

const gitVersion = /git version (\d+)\.(\d+)/.exec(runWorkspaceGitSync(process.cwd(), ["--version"]))!;
const supportsReftable = Number(gitVersion[1]) > 2 || (Number(gitVersion[1]) === 2 && Number(gitVersion[2]) >= 45);
test.skipIf(!supportsReftable)("reftable members verify the real branch and reject drift despite the placeholder HEAD file", async () => {
  const h = await gitFixture({}, "reftable"); const accepted = await h.accept("reftable", 1);
  const drain = h.dispatcher.kick(); await wait(() => h.runner.calls.length === 1);
  const session = h.sessions.getLogicalSessionRecord(h.runner.calls[0]!.sessionAlias)!;
  const resource = h.store.worktrees.get(accepted.run.id)!.resources[0]!;
  expect(h.worktrees!.resolveSessionCwd(session)).toBe(resource.worktreePath);
  expect((await h.worktrees!.git(resource.worktreePath, ["symbolic-ref", "HEAD"])).trim()).toBe(resource.branchRef);
  h.runner.finish(0); await drain;
  await h.worktrees!.git(resource.worktreePath, ["checkout", "-b", "changed-branch"]);
  expect(() => h.worktrees!.resolveSessionCwd(session)).toThrow("worktree registration, branch or owner token changed");
  h.store.close();
}, 60_000);

test("a text patch larger than 8 MiB previews with a bounded prefix and integrates its complete tree", async () => {
  const h = await gitFixture(); const accepted = await h.accept("large-patch", 1);
  const drain = h.dispatcher.kick(); await wait(() => h.runner.calls.length === 1);
  const cwd = h.sessions.getResolvedSessionByInternalAlias(h.runner.calls[0]!.sessionAlias)!.cwd;
  const content = ("x".repeat(255) + "\n").repeat(36 * 1024);
  expect(Buffer.byteLength(content)).toBeGreaterThan(8 * 1024 * 1024);
  await writeFile(join(cwd, "large.txt"), content); h.runner.finish(0); await drain;
  let r = await h.integrations!.operate({ action: "preview", runId: accepted.run.id, botIds: [h.ids[0]!] });
  const preview = r.preview!.members[0]!;
  expect(preview.diff).toContain("[Preview truncated;");
  expect(preview.diff.length).toBeLessThanOrEqual(32_768);
  expect(preview.files).toContain("large.txt");
  // An error exit after a truncated stdout must never look like a valid preview.
  await expect(runWorkspaceGitPreview(cwd, ["diff", "--exit-code", r.baseCommitSha, preview.tree])).rejects.toThrow("Git preview exited 1");
  r = await h.integrations!.operate({ action: "integrate", runId: r.runId, requestId: "large", previewId: r.preview!.id, snapshotUncommitted: true });
  expect(r.integration!.state).toBe("integrated");
  const candidate = r.resources.find(resource => resource.kind === "integration")!;
  expect(await readFile(join(candidate.worktreePath, "large.txt"), "utf8")).toBe(content);
  await expect(readFile(join(h.source, "large.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  h.store.close();
}, 90_000);

test("repeated previews and failed captures remove only their exact empty snapshot directories", async () => {
  const h = await gitFixture(); const accepted = await h.accept("private-index-cleanup", 1);
  const drain = h.dispatcher.kick(); await wait(() => h.runner.calls.length === 1);
  h.runner.finish(0); await drain;
  const indexes = join(h.worktrees!.root, ".indexes");
  for (let i = 0; i < 4; i++) {
    await h.integrations!.operate({ action: "preview", runId: accepted.run.id, botIds: [h.ids[0]!] });
    expect(await readdir(indexes)).toEqual([]);
  }
  const original = h.worktrees!.git.bind(h.worktrees!); let retained: string | undefined;
  let preserveUnexpectedFile = false;
  h.worktrees!.git = async (cwd, args, env) => {
    if (args[0] === "write-tree") {
      if (preserveUnexpectedFile) {
        retained = join(dirname(env!.GIT_INDEX_FILE!), "unexpected.txt");
        await writeFile(retained, "preserve unexpected contents");
      }
      throw new Error("injected snapshot index failure");
    }
    return original(cwd, args, env);
  };
  try {
    await expect(h.integrations!.operate({ action: "preview", runId: accepted.run.id, botIds: [h.ids[0]!] })).rejects.toThrow("injected snapshot index failure");
    expect(await readdir(indexes)).toEqual([]);
    preserveUnexpectedFile = true;
    await expect(h.integrations!.operate({ action: "preview", runId: accepted.run.id, botIds: [h.ids[0]!] })).rejects.toThrow("injected snapshot index failure");
    expect(await readFile(retained!, "utf8")).toBe("preserve unexpected contents");
    expect(await readdir(indexes)).toHaveLength(1);
  } finally { h.worktrees!.git = original; h.store.close(); }
}, 90_000);

test("same-line conflicts persist, survive reopen and continue explicitly without duplicate application", async () => {
  const h = await settledFixture(["member A\n", "member B\n"]);
  let r = await h.integrations!.operate({ action: "preview", runId: h.accepted.run.id, botIds: h.ids.slice(0, 2) });
  r = await h.integrations!.operate({ action: "integrate", runId: r.runId, requestId: "conflict", previewId: r.preview!.id, snapshotUncommitted: true });
  expect(r.integration!.state).toBe("conflicted"); expect(r.integration!.conflictFiles).toContain("same.txt");
  const candidate = r.resources.find(r => r.kind === "integration")!;
  expect(await readFile(join(r.resources[0]!.worktreePath, "same.txt"), "utf8")).toBe("member A\n");
  await expect(h.integrations!.operate({ action: "cleanup", runId: r.runId })).rejects.toMatchObject({ code: "worktree_cleanup_unsafe" });
  h.store.close(); const reopened = await SqliteConversationStore.open(h.path);
  const manager = new ConversationWorktreeManager(reopened.worktrees, h.worktrees!.root, h.config);
  const integrations = new WorktreeIntegrationService(manager, reopened, h.state, h.runtime, async () => {});
  await manager.reconcile(); expect(reopened.worktrees.get(r.runId)!.integration!.conflictFiles).toContain("same.txt");
  await writeFile(join(candidate.worktreePath, "same.txt"), "human resolution\n"); await manager.git(candidate.worktreePath, ["add", "same.txt"]);
  r = await integrations.operate({ action: "continue", runId: r.runId }); expect(r.integration!.state).toBe("integrated");
  expect(r.integration!.nextIndex).toBe(2); const head = r.integration!.candidateCommitSha;
  expect((await integrations.operate({ action: "recover", runId: r.runId })).integration!.candidateCommitSha).toBe(head);
  reopened.close();
}, 90_000);

for (const point of ["after-snapshot-ref", "after-snapshot-index", "after-pick"]) {
  test(`integration recovers ${point} without losing changes or applying a patch twice`, async () => {
    const h = await settledFixture(["A\nsecond\nthird\n", "first\nsecond\nB\n"]);
    let hit = false;
    const manager = new ConversationWorktreeManager(h.store.worktrees, h.worktrees!.root, h.config,
      { checkpoint: async p => { if (p === point && !hit) { hit = true; throw new Error("simulated persistence gap"); } } });
    const service = new WorktreeIntegrationService(manager, h.store, h.state, h.runtime, async alias => { await h.sessions.removeSession(alias); });
    let r = await service.operate({ action: "preview", runId: h.accepted.run.id, botIds: h.ids.slice(0, 2) });
    await expect(service.operate({ action: "integrate", runId: r.runId, requestId: "gap", previewId: r.preview!.id, snapshotUncommitted: true })).rejects.toThrow("simulated persistence gap");
    expect(h.store.worktrees.get(r.runId)!.integration!.state).toBe("recovery-required");
    if (point === "after-pick") {
      const interrupted = h.store.worktrees.get(r.runId)!; interrupted.integration!.state = "integrating"; h.store.worktrees.save(interrupted);
      const path = interrupted.resources.find(v => v.kind === "integration")!.worktreePath;
      const head = (await manager.git(path, ["rev-parse", "HEAD"])).trim();
      await manager.reconcile(); expect(h.store.worktrees.get(r.runId)!.integration!.state).toBe("recovery-required");
      expect((await manager.git(path, ["rev-parse", "HEAD"])).trim()).toBe(head);
    }
    r = await service.operate({ action: "recover", runId: r.runId }); expect(r.integration!.state).toBe("integrated");
    const candidate = r.resources.find(v => v.kind === "integration")!;
    expect(Number((await manager.git(candidate.worktreePath, ["rev-list", "--count", `${r.baseCommitSha}..HEAD`])).trim())).toBe(2);
    expect(await readFile(join(candidate.worktreePath, "same.txt"), "utf8")).toBe("A\nsecond\nB\n");
    h.store.close();
  }, 90_000);
}

test("integration recovery and cleanup preserve unexpected candidate changes", async () => {
  const h = await settledFixture(["A\nsecond\nthird\n", "first\nsecond\nB\n"]);
  let hit = false;
  const manager = new ConversationWorktreeManager(h.store.worktrees, h.worktrees!.root, h.config,
    { checkpoint: async p => { if (p === "after-pick" && !hit) { hit = true; throw new Error("pick persistence gap"); } } });
  const service = new WorktreeIntegrationService(manager, h.store, h.state, h.runtime, async alias => { await h.sessions.removeSession(alias); });
  let r = await service.operate({ action: "preview", runId: h.accepted.run.id, botIds: h.ids.slice(0, 2) });
  await expect(service.operate({ action: "integrate", runId: r.runId, requestId: "ambiguous", previewId: r.preview!.id, snapshotUncommitted: true })).rejects.toThrow();
  r = h.store.worktrees.get(r.runId)!; const candidate = r.resources.find(v => v.kind === "integration")!;
  const extra = join(candidate.worktreePath, "human.txt"); await writeFile(extra, "retain this");
  await expect(service.operate({ action: "recover", runId: r.runId })).rejects.toMatchObject({ code: "worktree_integration_ambiguous" });
  expect(await readFile(extra, "utf8")).toBe("retain this"); await unlink(extra);
  r = await service.operate({ action: "recover", runId: r.runId }); expect(r.integration!.state).toBe("integrated");
  await writeFile(extra, "new human commit"); await manager.git(candidate.worktreePath, ["add", "human.txt"]);
  await manager.git(candidate.worktreePath, ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "later human work"]);
  await expect(service.operate({ action: "cleanup", runId: r.runId })).rejects.toMatchObject({ code: "worktree_cleanup_unsafe" });
  expect(await readFile(extra, "utf8")).toBe("new human commit"); h.store.close();
}, 90_000);

for (const point of ["before-remove", "after-remove"]) {
  test(`cleanup interruption at ${point} retains its owner and converges on retry`, async () => {
    const h = await gitFixture(); const a = await h.accept("empty", 1);
    await h.worktrees!.prepare(a.run.id, h.ids[0]!, () => {}); await h.service.cancelRun(a.run.id);
    let hit = false;
    const manager = new ConversationWorktreeManager(h.store.worktrees, h.worktrees!.root, h.config,
      { checkpoint: async p => { if (p === point && !hit) { hit = true; throw new Error("remove interruption"); } } });
    await expect(manager.cleanup(a.run.id)).rejects.toThrow("remove interruption");
    expect(h.store.worktrees.get(a.run.id)!.resources[0]!.state).toBe("cleanup-failed");
    expect((await manager.cleanup(a.run.id)).resources[0]!.state).toBe("cleaned"); h.store.close();
  }, 60_000);
}

test("preview drift rejects snapshot authorization without changing member HEAD or main", async () => {
  const h = await settledFixture(["A\n", "B\n"]);
  const r = await h.integrations!.operate({ action: "preview", runId: h.accepted.run.id, botIds: h.ids.slice(0, 2) });
  await writeFile(join(r.resources[0]!.worktreePath, "later.txt"), "later human work");
  await expect(h.integrations!.operate({ action: "integrate", runId: r.runId, requestId: "stale", previewId: r.preview!.id, snapshotUncommitted: true })).rejects.toMatchObject({ code: "worktree_preview_stale" });
  expect(h.store.worktrees.get(r.runId)!.integration).toBeUndefined(); h.store.close();
}, 60_000);

test("abandon retains dirty results and next Run gets new resources at its own frozen base", async () => {
  const h = await settledFixture(["A\n", "B\n"]);
  let r = await h.integrations!.operate({ action: "abandon", runId: h.accepted.run.id });
  await expect(h.integrations!.operate({ action: "cleanup", runId: r.runId })).rejects.toMatchObject({ code: "worktree_cleanup_unsafe" });
  const next = await h.accept("next", 1); const ref = await h.worktrees!.prepare(next.run.id, h.ids[0]!, () => {});
  const path = await h.worktrees!.verifyReference(ref);
  expect(path).not.toBe(r.resources[0]!.worktreePath);
  expect(await readFile(join(path, "same.txt"), "utf8")).toBe("first\nsecond\nthird\n");
  expect(await readFile(join(r.resources[0]!.worktreePath, "same.txt"), "utf8")).toBe("A\n");
  const nextDrain = h.dispatcher.kick(); await wait(() => h.runner.calls.length === 3);
  expect(h.sessions.getResolvedSessionByInternalAlias(h.runner.calls[2]!.sessionAlias)!.cwd).toBe(path);
  expect(h.runner.calls[2]!.logicalSessionId).not.toBe(h.runner.calls[0]!.logicalSessionId);
  h.runner.finish(2); await nextDrain; h.store.close();
}, 60_000);

test("teardown preserves dirty results and deleting barrier until explicit integration permits cleanup", async () => {
  const h = await settledFixture(["A\nsecond\nthird\n", "first\nsecond\nB\n"]);
  await expect(h.service.teardownGroupTopic(h.g.id, h.topic.id)).rejects.toMatchObject({ code: "worktree_cleanup_unsafe" });
  expect(h.state.conversation_topics[h.topic.id]!.status).toBe("deleting");
  expect(h.store.getRun(h.accepted.run.id)).toBeDefined();
  let r = await h.integrations!.operate({ action: "preview", runId: h.accepted.run.id, botIds: h.ids.slice(0, 2) });
  r = await h.integrations!.operate({ action: "integrate", runId: r.runId, requestId: "teardown", previewId: r.preview!.id, snapshotUncommitted: true });
  await h.service.teardownGroupTopic(h.g.id, h.topic.id);
  expect(h.state.conversation_topics[h.topic.id]).toBeUndefined(); expect(h.store.worktrees.get(r.runId)!.resources.every(r => r.state === "cleaned")).toBe(true);
  h.store.close();
}, 90_000);

test("untracked/binary results integrate, while ignored data prevents cleanup", async () => {
  const h = await gitFixture(); const a = await h.accept(); const drain = h.dispatcher.kick(); await wait(() => h.runner.calls.length === 2);
  const paths = h.runner.calls.map(c => h.sessions.getResolvedSessionByInternalAlias(c.sessionAlias)!.cwd);
  await writeFile(join(paths[0]!, "new.bin"), Buffer.from([0, 1, 255])); await writeFile(join(paths[1]!, "new.txt"), "untracked");
  await writeFile(join(paths[0]!, ".gitignore"), "retained.log\n"); await writeFile(join(paths[0]!, "retained.log"), "must retain");
  h.runner.finish(0); h.runner.finish(1); await drain;
  let r = await h.integrations!.operate({ action: "preview", runId: a.run.id, botIds: h.ids.slice(0, 2) });
  expect(r.preview!.members[0]!.files).toContain("new.bin"); expect(r.preview!.members[0]!.files).not.toContain("retained.log");
  r = await h.integrations!.operate({ action: "integrate", runId: a.run.id, requestId: "binary", previewId: r.preview!.id, snapshotUncommitted: true });
  expect(r.integration!.state).toBe("integrated"); const candidate = r.resources.find(v => v.kind === "integration")!;
  expect(await readFile(join(candidate.worktreePath, "new.bin"))).toEqual(Buffer.from([0, 1, 255]));
  await expect(h.integrations!.operate({ action: "cleanup", runId: r.runId })).rejects.toMatchObject({ code: "worktree_cleanup_unsafe" });
  expect(await readFile(join(paths[0]!, "retained.log"), "utf8")).toBe("must retain"); h.store.close();
}, 90_000);

test("delete/modify conflict retains both member results and candidate conflict state", async () => {
  const h = await gitFixture(); const a = await h.accept(); const drain = h.dispatcher.kick(); await wait(() => h.runner.calls.length === 2);
  const paths = h.runner.calls.map(c => h.sessions.getResolvedSessionByInternalAlias(c.sessionAlias)!.cwd);
  await unlink(join(paths[0]!, "same.txt")); await writeFile(join(paths[1]!, "same.txt"), "modified\n");
  h.runner.finish(0); h.runner.finish(1); await drain;
  let r = await h.integrations!.operate({ action: "preview", runId: a.run.id, botIds: h.ids.slice(0, 2) });
  r = await h.integrations!.operate({ action: "integrate", runId: r.runId, requestId: "delete-modify", previewId: r.preview!.id, snapshotUncommitted: true });
  expect(r.integration!.state).toBe("conflicted"); expect(r.integration!.conflictFiles).toContain("same.txt"); h.store.close();
}, 90_000);

test("managed ownership and public status cannot mint proof or leak the resource token", async () => {
  const h = await gitFixture(); const a = await h.accept("owner", 1); await h.worktrees!.prepare(a.run.id, h.ids[0]!, () => {});
  const r = h.store.worktrees.get(a.run.id)!; expect(JSON.stringify(worktreeStatus(r))).not.toContain(r.resources[0]!.ownerToken);
  expect(h.store.getMemberTurn(a.memberTurns[0]!.id)!.effect ?? "unknown").toBe("unknown");
  expect(h.store.getMemberTurn(a.memberTurns[0]!.id)!.effectProvenance).toBeUndefined();
  const sql = await createSqlDriver(h.path); const malformed = structuredClone(r); malformed.resources[0]!.ownerToken = "forged";
  sql.run("UPDATE conversation_worktree_runs SET record_json = ? WHERE run_id = ?", [JSON.stringify(malformed), a.run.id]); sql.close();
  expect(() => h.store.worktrees.get(a.run.id)).toThrow("invalid durable worktree"); h.store.close();
}, 30_000);

for (const phase of ["claimed", "started-unknown", "started-read-only"] as const) {
  test(`real dispatcher restart ${phase} reuses verified cwd without blind writable retry`, async () => {
    const h = await gitFixture();
    const a = await h.service.acceptGroupPrompt({ conversationId: h.g.id, topicId: h.topic.id, requestId: "restart", text: "inspect",
      target: { mode: "members", botIds: h.ids.slice(0, 3) }, humanIngress: HUMAN,
      ...(phase === "started-read-only" ? { memberPolicies: h.ids.slice(0, 3).map(botId => ({ botId, filesystem: "read-only" as const })) } : {}) });
    for (let n = 0; n < 2; n++) {
      const claim = h.store.claimNextDispatch({ now: h.now().toISOString(), owner: h.dispatcher.ownerId, authorityEpoch: h.dispatcher.authorityEpoch,
        leaseExpiresAt: "2099-01-01T00:00:00.000Z", topicConcurrencyLimits: { [h.topic.id]: 2 } })!;
      const ref = await h.worktrees!.prepare(a.run.id, claim.memberTurn.botId, () => {});
      const binding = await h.runtime.getOrCreateGroupMemberSession({ botId: claim.memberTurn.botId, conversationId: h.g.id, topicId: h.topic.id,
        execution: claim.memberSnapshot.execution, executionWorktree: ref,
        executionPolicy: h.runtime.executionPolicyFor(claim.memberTurn, claim.memberSnapshot.execution.agent) });
      if (phase !== "claimed") h.store.markExecutionStarted({ dispatchId: claim.dispatch.id, owner: h.dispatcher.ownerId, generation: claim.dispatch.generation,
        runId: a.run.id, memberTurnId: claim.memberTurn.id, sessionAlias: binding.sessionAlias, logicalSessionId: binding.logicalSessionId,
        sourceTurnId: `old-${n}`, now: h.now().toISOString() });
    }
    const before = h.store.worktrees.get(a.run.id)!; h.store.close();
    const next = await harness({ path: h.path, state: parseState(JSON.parse(JSON.stringify(h.state))), workspaceCwd: h.source, worktreeRoot: h.worktrees!.root, ownerId: "restart-owner" });
    const activation = next.service.activateAfterConsumerLock();
    if (phase === "started-unknown") {
      await activation; expect(next.runner.calls).toHaveLength(0); expect(next.store.getRun(a.run.id)!.state).toBe("indeterminate");
    } else {
      await wait(() => next.runner.calls.length === 2); expect(next.runner.peak).toBe(2);
      next.runner.finish(0); next.runner.finish(1); await wait(() => next.runner.calls.length === 3); next.runner.finish(2); await activation;
      expect(next.runner.peak).toBe(2); expect(next.store.getRun(a.run.id)!.state).toBe("completed");
      expect(next.runner.calls.every(c => c.executionOrigin === "orchestration")).toBe(true);
    }
    expect(next.store.worktrees.get(a.run.id)!.resources.slice(0, 2).map(r => [r.id, r.worktreePath])).toEqual(before.resources.map(r => [r.id, r.worktreePath]));
    next.store.close();
  }, 90_000);
}

test("path disappearance and branch collision never downgrade into the source workspace", async () => {
  let collision = false; let h: Awaited<ReturnType<typeof gitFixture>>;
  h = await gitFixture({ worktreeHooks: { checkpoint: async (point, id) => {
    if (point === "before-add" && !collision) { collision = true; const r = h.store.worktrees.get(id)!.resources[0]!;
      await h.worktrees!.git(h.source, ["branch", r.branchRef.slice(11), "HEAD"]); }
  } } });
  const a = await h.accept("collision", 1); await h.dispatcher.kick(); expect(h.runner.calls).toHaveLength(0);
  const record = h.store.worktrees.get(a.run.id)!;
  expect(record.resources[0]!.state).toBe("provision-failed");
  expect(JSON.stringify(worktreeStatus(record))).not.toContain(record.resources[0]!.ownerToken); h.store.close();
}, 40_000);

test("missing formerly-ready path remains missing after restart and has zero provider calls", async () => {
  const h = await gitFixture(); const a = await h.accept("missing", 1); const ref = await h.worktrees!.prepare(a.run.id, h.ids[0]!, () => {});
  const path = await h.worktrees!.verifyReference(ref); await rename(path, `${path}-preserved`);
  await h.worktrees!.reconcile(); expect(h.store.worktrees.get(a.run.id)!.resources[0]!.state).toBe("missing");
  await h.dispatcher.kick(); expect(h.runner.calls).toHaveLength(0); h.store.close();
}, 40_000);

test("resource path forgery cannot remove a foreign dirty directory", async () => {
  const h = await gitFixture(); const a = await h.accept("foreign", 1); await h.worktrees!.prepare(a.run.id, h.ids[0]!, () => {});
  await h.service.cancelRun(a.run.id); const run = h.store.worktrees.get(a.run.id)!;
  const foreign = join(h.dir, "foreign"); await mkdir(foreign); await writeFile(join(foreign, "data"), "owned by human");
  run.resources[0]!.worktreePath = foreign;
  const sql = await createSqlDriver(h.path); sql.run("UPDATE conversation_worktree_runs SET record_json = ? WHERE run_id = ?", [JSON.stringify(run), run.runId]); sql.close();
  await expect(h.worktrees!.cleanup(a.run.id)).rejects.toMatchObject({ code: "worktree_identity_mismatch" });
  expect(await readFile(join(foreign, "data"), "utf8")).toBe("owned by human"); h.store.close();
}, 40_000);

test("managed path junction/symlink cannot substitute another resource owner", async () => {
  const h = await gitFixture(); const a = await h.accept("link", 1);
  await h.worktrees!.prepare(a.run.id, h.ids[0]!, () => {});
  const r = h.store.worktrees.get(a.run.id)!.resources[0]!;
  const original = join(h.dir, "preserved-worktree"); await rename(r.worktreePath, original);
  await symlink(original, r.worktreePath, process.platform === "win32" ? "junction" : "dir");
  await expect(h.worktrees!.verifyReference({ runId: a.run.id, worktreeId: r.id, generation: 1 })).rejects.toMatchObject({ code: "worktree_identity_mismatch" });
  await h.dispatcher.kick(); expect(h.runner.calls).toHaveLength(0);
  expect(await readFile(join(original, "same.txt"), "utf8")).toBe("first\nsecond\nthird\n"); h.store.close();
}, 40_000);

test("non-Git workspace cannot create a worktree Run", async () => {
  const h = await gitFixture(); const plain = join(h.dir, "plain"); await mkdir(plain);
  h.config.workspaces.backend!.cwd = plain;
  await expect(h.accept("not-git", 1)).rejects.toThrow();
  expect(h.store.listRuns(h.g.id, h.topic.id)).toHaveLength(0); h.store.close();
}, 30_000);

test("Bot disable during provisioning fences the physical start and retains the created resource", async () => {
  const hit = deferred(), resume = deferred();
  const h = await gitFixture({ worktreeHooks: { checkpoint: async point => { if (point === "after-add") { hit.resolve(); await resume.promise; } } } });
  const a = await h.accept("disable", 1); const drain = h.dispatcher.kick(); await hit.promise;
  await h.bots.updateBot(h.ids[0]!, { enabled: false }); resume.resolve(); await drain;
  expect(h.runner.calls).toHaveLength(0); expect(h.store.worktrees.get(a.run.id)!.resources).toHaveLength(1); h.store.close();
}, 40_000);

test("Topic teardown during provisioning cancels admission before removing only the verified empty resource", async () => {
  const hit = deferred(), resume = deferred();
  const h = await gitFixture({ worktreeHooks: { checkpoint: async point => { if (point === "after-add") { hit.resolve(); await resume.promise; } } } });
  const a = await h.accept("teardown-preparation", 1); const drain = h.dispatcher.kick(); await hit.promise;
  const teardown = h.service.teardownGroupTopic(h.g.id, h.topic.id);
  await wait(() => h.store.getRun(a.run.id)?.state === "cancelled"); expect(h.runner.calls).toHaveLength(0);
  resume.resolve(); await Promise.all([drain, teardown]);
  expect(h.store.worktrees.get(a.run.id)!.resources.every(r => r.state === "cleaned")).toBe(true);
  expect(h.state.conversation_topics[h.topic.id]).toBeUndefined(); h.store.close();
}, 40_000);

test("same Run and member reuses its resource; accepted repository and snapshot evidence cannot be rewritten", async () => {
  const h = await gitFixture(); const a = await h.accept("identity", 1);
  const first = await h.worktrees!.prepare(a.run.id, h.ids[0]!, () => {});
  await writeFile(join(h.store.worktrees.get(a.run.id)!.resources[0]!.worktreePath, "retained.txt"), "first turn");
  expect(await h.worktrees!.prepare(a.run.id, h.ids[0]!, () => {})).toEqual(first);
  expect(h.store.worktrees.get(a.run.id)!.resources).toHaveLength(1);
  const changed = h.store.worktrees.get(a.run.id)!; changed.baseCommitSha = "a".repeat(40);
  expect(() => h.store.worktrees.save(changed)).toThrow("immutable"); h.store.close();
}, 40_000);

test("completion racing cancel cannot refill a cancelled worktree batch", async () => {
  const h = await gitFixture(); const a = await h.accept("cancel-refill", 3); const drain = h.dispatcher.kick();
  await wait(() => h.runner.calls.length === 2);
  const cancel = h.service.cancelRun(a.run.id); h.runner.finish(0); await cancel; await drain;
  expect(h.runner.calls).toHaveLength(2); expect(h.runner.peak).toBe(2);
  expect(h.store.getRun(a.run.id)!.state).toBe("cancelled"); h.store.close();
}, 50_000);

test("two simultaneous completions refill exactly one remaining reservation", async () => {
  const h = await gitFixture(); const a = await h.accept("two-completions", 3); const drain = h.dispatcher.kick();
  await wait(() => h.runner.calls.length === 2); h.runner.finish(0); h.runner.finish(1);
  await wait(() => h.runner.calls.length === 3); h.runner.finish(2); await drain;
  expect(h.runner.peak).toBe(2); expect(h.store.listMemberTurns(a.run.id).every(m => m.state === "completed")).toBe(true); h.store.close();
}, 50_000);

test("custom Git filters are rejected before acceptance", async () => {
  const h = await gitFixture(); await writeFile(join(h.source, ".gitattributes"), "same.txt filter=unsafe\n");
  await h.worktrees!.git(h.source, ["add", ".gitattributes"]);
  await h.worktrees!.git(h.source, ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "attributes"]);
  await expect(h.accept("filter", 1)).rejects.toMatchObject({ code: "worktree_unsupported_tree" });
  expect(h.store.listRuns(h.g.id, h.topic.id)).toHaveLength(0); h.store.close();
}, 30_000);

test("owned Git operations never execute repository checkout or commit hooks", async () => {
  const h = await gitFixture();
  for (const name of ["post-checkout", "pre-commit", "post-commit"]) {
    const hook = join(h.source, ".git", "hooks", name); await writeFile(hook, "#!/bin/sh\nprintf unsafe > hook-ran\n"); await chmod(hook, 0o755);
  }
  const a = await h.accept("hooks", 1); const ref = await h.worktrees!.prepare(a.run.id, h.ids[0]!, () => {});
  const path = await h.worktrees!.verifyReference(ref);
  await writeFile(join(path, "same.txt"), "authorized result"); await h.worktrees!.git(path, ["add", "same.txt"]);
  await h.worktrees!.git(path, ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "controlled commit"]);
  await expect(readFile(join(path, "hook-ran"))).rejects.toMatchObject({ code: "ENOENT" });
  await expect(readFile(join(h.source, "hook-ran"))).rejects.toMatchObject({ code: "ENOENT" }); h.store.close();
}, 40_000);

test("public handoff to an earlier member reuses its worktree and preserves orchestration authority", async () => {
  const h = await gitFixture(); const handoffs = new GroupHandoffService({ store: h.store, bots: h.bots, state: h.state, now: h.now,
    wake: () => { void h.dispatcher.kick(); } });
  h.dispatcher.setHandoffService(handoffs);
  const a = await h.accept("handoff"); const drain = h.dispatcher.kick(); await wait(() => h.runner.calls.length === 2);
  const source = h.runner.calls.findIndex(c => c.botId === h.ids[0]); const sender = 1 - source;
  const cwd = h.sessions.getResolvedSessionByInternalAlias(h.runner.calls[source]!.sessionAlias)!.cwd;
  await writeFile(join(cwd, "previous.txt"), "preserve across member turns"); h.runner.finish(source);
  await wait(() => h.store.getMemberTurn(h.runner.calls[source]!.memberTurnId)?.state === "completed");
  await handoffs.send({ executionToken: h.runner.calls[sender]!.groupExecutionToken!, invocationId: "reuse", args: { to: h.ids[0], task: "continue earlier work" } });
  h.runner.finish(sender); await wait(() => h.runner.calls.length === 3);
  expect(h.sessions.getResolvedSessionByInternalAlias(h.runner.calls[2]!.sessionAlias)!.cwd).toBe(cwd);
  expect(await readFile(join(cwd, "previous.txt"), "utf8")).toBe("preserve across member turns");
  expect(h.runner.calls[2]!.executionOrigin).toBe("orchestration");
  expect(h.store.worktrees.get(a.run.id)!.resources).toHaveLength(2); h.runner.finish(2); await drain; handoffs.close(); h.store.close();
}, 60_000);

for (const engine of ["cli", "runtime"] as const) {
  test(`${engine} launches a real ACP child in the verified member worktree`, async () => {
    const h = await gitFixture({ transport: { engine, ...(engine === "runtime" ? { type: "acpx-bridge" as const } : {}) } });
    h.sessions.setRuntimeCapability({ runtimeAvailable: true, runtimeImportOk: true, contractProbeOk: true });
    h.config.agents.codex!.argv = ["node", resolve("tests/fixtures/mock-acp-agent.mjs")];
    const a = await h.accept(`physical-${engine}`, 2); const drain = h.dispatcher.kick(); await wait(() => h.runner.calls.length === 2);
    const sessions = h.runner.calls.map(c => h.sessions.getResolvedSessionByInternalAlias(c.sessionAlias)!);
    expect(sessions.every(s => s.transportEngine === engine)).toBe(true);
    let texts: string[] = [];
    if (engine === "cli") {
      const home = join(h.dir, "cli-home"); await mkdir(join(home, ".acpx"), { recursive: true });
      await writeFile(join(home, ".acpx", "config.json"), JSON.stringify({ agents: { [sessions[0]!.acpxAgent!]: { argv: sessions[0]!.agentArgv } } }));
      const transport = new AcpxCliTransport({ command: resolveAcpxCommand({ configuredCommand: undefined }), queueOwnerTtlSeconds: 1,
        resolveSpawnEnvironment: () => ({ ...process.env, HOME: home, USERPROFILE: home }) });
      try {
        // Keep catalog creation separate from physical prompt overlap.
        for (const s of sessions) await transport.ensureSession(s);
        if (process.platform === "win32") {
          // acpx 0.16.0's shared catalog rename can fail EPERM during concurrent
          // CLI startup. Validate both real cwd/write paths here; Runtime and
          // dispatcher tests independently exercise physical overlap on Windows.
          for (let n = 0; n < sessions.length; n++) texts.push((await transport.prompt(sessions[n]!, `worktree-write:${engine}-${n}`)).text);
        } else texts = await Promise.all(sessions.map(async (s, n) => (await transport.prompt(s, `worktree-write:${engine}-${n}`)).text));
      } finally { for (const s of sessions) await transport.deleteSession(s).catch(() => {}); }
    } else {
      const out = join(h.dir, "worker");
      const built = await Bun.build({ entrypoints: [resolve("src/bridge/engine/runtime/runtime-worker-main.ts")], outdir: out, target: "node", external: ["acpx", "node-pty", "fs-ext", "write-file-atomic"] });
      expect(built.success).toBe(true);
      const runtime = new RuntimeEngine({ workerEntryPath: join(out, "runtime-worker-main.js"), stateDir: join(h.dir, "runtime-state", "sessions"),
        durableRootDir: join(h.dir, "runtime-durable"), permissionMode: "approve-all" });
      try {
        texts = await Promise.all(sessions.map(async (s, n) => (await runtime.prompt({ agent: s.agent, agentCommand: s.agentCommand, acpxAgent: s.acpxAgent,
          agentArgv: s.agentArgv, cwd: s.cwd, name: s.transportSession, logicalSessionId: s.logicalSessionId,
          text: `worktree-write:${engine}-${n}` }, async () => {})).text));
      } finally { await runtime.shutdown(); }
    }
    for (let n = 0; n < sessions.length; n++) {
      expect(texts[n]!.replaceAll("\\", "/")).toContain(`cwd=${sessions[n]!.cwd.replaceAll("\\", "/")}`);
      expect(h.store.worktrees.get(a.run.id)!.resources.some(r => r.worktreePath === sessions[n]!.cwd)).toBe(true);
      expect(await readFile(join(sessions[n]!.cwd, "same.txt"), "utf8")).toBe(`${engine}-${n}`);
      h.runner.finish(n);
    }
    expect(await readFile(join(h.source, "same.txt"), "utf8")).toBe("first\nsecond\nthird\n");
    await drain; h.store.close();
  }, 90_000);
}
