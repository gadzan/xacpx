import { expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runWorkspaceGit } from "../../../src/control/workspace-git";
import { deferred, harness, HUMAN } from "./fixtures/concurrency-harness";
import type { ConversationTopic } from "../../../src/conversations/conversation-types";

/** Git-backed harness with one Group Topic whose isolation the test chooses. */
async function fixture(isolation: "shared" | "shared-single-writer" | "worktree-per-member") {
  const dir = await mkdtemp(join(tmpdir(), "xacpx-isolation-")), source = join(dir, "source");
  await runWorkspaceGit(dir, ["init", "--initial-branch=main", source]);
  await runWorkspaceGit(source, ["config", "core.autocrlf", "false"]);
  await writeFile(join(source, "same.txt"), "first\nsecond\nthird\n");
  await runWorkspaceGit(source, ["add", "."]);
  await runWorkspaceGit(source, ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "base"]);
  const h = await harness({ workspaceCwd: source, worktreeRoot: join(dir, "managed") });
  const g = await h.bots.createGroup({ title: "Isolation", botIds: h.ids });
  const topic = await h.service.createGroupTopic(g.id, "Round", { workspace: "backend", isolation }, { maxConcurrentMemberTurns: 4 });
  const accept = (id = "request", count = 2) => h.service.acceptGroupPrompt({ conversationId: g.id, topicId: topic.id,
    requestId: id, text: "work independently", target: { mode: "members", botIds: h.ids.slice(0, count) }, humanIngress: HUMAN });
  return { ...h, dir, source, topic, g, accept };
}

async function wait(check: () => boolean) {
  const end = Date.now() + 20_000;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out waiting for the scheduler");
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 5);
    await promise;
  }
}

// Real git worktree provisioning on Windows needs more than the default budget.
const SLOW = 60_000;

test("a shared-single-writer round executes one member at a time", async () => {
  const h = await fixture("shared-single-writer");
  const accepted = await h.accept("serial", 2);
  expect(accepted.memberTurns).toHaveLength(2);
  void h.dispatcher.kick();
  await wait(() => h.runner.calls.length === 1);
  // Durable evidence, not a sleep: the sibling stays queued while the running
  // member holds the writer slot on the shared directory.
  const turns = h.store.listMemberTurns(accepted.run.id);
  expect(turns.filter((turn) => turn.state === "running")).toHaveLength(1);
  const parked = turns.filter((turn) => turn.state !== "running");
  expect(parked).toHaveLength(1);
  expect(parked[0]!.startedAt).toBeUndefined();
  expect(h.runner.calls).toHaveLength(1);
  h.runner.finish(0);
  await wait(() => h.runner.calls.length === 2);
  expect(h.runner.peak).toBe(1);
});

test("switching to worktree-per-member lets the round's members execute concurrently", async () => {
  const h = await fixture("shared-single-writer");
  const switched = await h.service.setGroupTopicIsolation(h.g.id, h.topic.id, "worktree-per-member");
  expect(switched.executionTarget?.isolation).toBe("worktree-per-member");
  expect(switched.id).toBe(h.topic.id);
  expect(switched.title).toBe(h.topic.title);

  await h.accept("parallel", 2);
  void h.dispatcher.kick();
  await wait(() => h.runner.calls.length === 2);
  const cwd = h.runner.calls.map((call) => h.sessions.getResolvedSessionByInternalAlias(call.sessionAlias)!.cwd);
  expect(cwd[0]).not.toBe(cwd[1]);
  expect(cwd).not.toContain(h.source);
  expect(h.runner.peak).toBe(2);
}, SLOW);

test("an in-flight run keeps the topic on its current isolation", async () => {
  const h = await fixture("shared-single-writer");
  const accepted = await h.accept("inflight", 2);
  void h.dispatcher.kick();
  await wait(() => h.runner.calls.length === 1);
  await expect(h.service.setGroupTopicIsolation(h.g.id, h.topic.id, "worktree-per-member"))
    .rejects.toThrow(/unsettled runs/);
  const after = await h.service.listTopics(h.g.id);
  expect(after.find((topic: ConversationTopic) => topic.id === h.topic.id)?.executionTarget?.isolation)
    .toBe("shared-single-writer");
  expect(h.store.listMemberTurns(accepted.run.id).filter((turn) => turn.state === "running")).toHaveLength(1);
}, SLOW);

test("selecting the isolation a topic already has is a no-op", async () => {
  const h = await fixture("worktree-per-member");
  const same = await h.service.setGroupTopicIsolation(h.g.id, h.topic.id, "worktree-per-member");
  expect(same.executionTarget?.isolation).toBe("worktree-per-member");
}, SLOW);

test("leaving worktree mode is refused while its worktrees are unintegrated", async () => {
  const h = await fixture("worktree-per-member");
  await h.accept("leave-wt", 2);
  void h.dispatcher.kick();
  await wait(() => h.runner.calls.length === 2);
  // Silent replies: a stored group reply relays to the other members, which
  // would park the Run in a round this test never finishes. The subject is the
  // settled-but-unintegrated worktree, not the relay.
  h.runner.finish(0, { status: "completed", text: "[静默]" });
  h.runner.finish(1, { status: "completed", text: "[静默]" });
  await wait(() => h.store.listRuns(h.g.id, h.topic.id).every((run) => run.state === "completed"));
  // Settled but not integrated: the worktree panel is mounted off the live
  // isolation, so a downgrade would hide the only way to integrate them.
  const pending = h.store.listWorktreeRunIds(h.g.id, h.topic.id);
  expect(pending).toHaveLength(1);
  await expect(h.service.setGroupTopicIsolation(h.g.id, h.topic.id, "shared"))
    .rejects.toMatchObject({ code: "worktree_runs_pending", details: { runIds: pending } });
  expect(h.service.listTopics(h.g.id).find((topic) => topic.id === h.topic.id)?.executionTarget?.isolation)
    .toBe("worktree-per-member");
}, SLOW);

test("a deleting topic refuses the switch even when the policy already matches", async () => {
  const h = await fixture("shared-single-writer");
  h.store.markTopicDeleting(h.topic.id, h.g.id, new Date().toISOString());
  await expect(h.service.setGroupTopicIsolation(h.g.id, h.topic.id, "shared-single-writer"))
    .rejects.toMatchObject({ code: "topic_deleting" });
}, SLOW);

test("worktree isolation stays unavailable without a provisioning manager", async () => {
  const dir = await mkdtemp(join(tmpdir(), "xacpx-isolation-nowt-"));
  const h = await harness({ workspaceCwd: dir });
  const g = await h.bots.createGroup({ title: "No worktrees", botIds: h.ids });
  const topic = await h.service.createGroupTopic(g.id, "Round", { workspace: "backend", isolation: "shared-single-writer" });
  await expect(h.service.setGroupTopicIsolation(g.id, topic.id, "worktree-per-member"))
    .rejects.toMatchObject({ code: "worktree_unprovisioned" });
});

test("a concurrent topic creation is not lost behind the isolation write", async () => {
  const h = await fixture("shared-single-writer");
  const entered = deferred();
  const release = deferred();
  const original = h.stateStore.saveNow.bind(h.stateStore);
  h.stateStore.saveNow = async (state: Parameters<typeof original>[0]) => {
    if (armed) {
      armed = false;
      entered.resolve();
      await release.promise;
    }
    await original(state);
  };
  let armed = true;
  const switching = h.service.setGroupTopicIsolation(h.g.id, h.topic.id, "worktree-per-member");
  // The switch cloned state and is parked on its own write; a second mutation
  // commits meanwhile. It must wait for the mutex, not disappear under the
  // stale clone this write installs when it resumes.
  await entered.promise;
  const creating = h.service.createGroupTopic(h.g.id, "Created during switch", {
    workspace: "backend",
    isolation: "shared-single-writer",
  });
  release.resolve();
  await Promise.all([switching, creating]);
  const topics = h.service.listTopics(h.g.id);
  expect(topics.map((topic) => topic.title)).toEqual(expect.arrayContaining(["Round", "Created during switch"]));
  expect(topics.find((topic) => topic.id === h.topic.id)?.executionTarget?.isolation).toBe("worktree-per-member");
}, SLOW);
