import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { harness, HUMAN, until } from "./fixtures/concurrency-harness";

/**
 * Group workspace mode (`shared` | `per-member`).
 *
 * A `shared` Group keeps today's rule: the Topic owns one work target and every
 * member runs in it. A `per-member` Group has no work target at all — each
 * member runs in its own Bot workspace, and scheduling follows the physical
 * directory that implies rather than the isolation enum.
 */

async function splitHarness() {
  const backendDir = await mkdtemp(join(tmpdir(), "xacpx-ws-backend-"));
  const altDir = await mkdtemp(join(tmpdir(), "xacpx-ws-alt-"));
  const h = await harness({ workspaceCwd: backendDir, altWorkspaceCwd: altDir });
  const backend = Object.values(h.state.bots).filter((bot) => bot.workspace === "backend").map((bot) => bot.id);
  const alt = Object.values(h.state.bots).filter((bot) => bot.workspace === "alt").map((bot) => bot.id);
  return {
    h,
    backend,
    alt,
    async cleanup() {
      h.store.close();
      await rm(backendDir, { recursive: true, force: true });
      await rm(altDir, { recursive: true, force: true });
    },
  };
}

test("a per-member Group accepts each member against its own Bot workspace", async () => {
  const { h, backend, alt, cleanup } = await splitHarness();
  try {
    const members = [backend[0]!, backend[1]!, alt[0]!];
    const group = await h.bots.createGroup({ title: "Split", botIds: members, workspaceMode: "per-member" });
    expect(group.workspaceMode).toBe("per-member");
    const topic = await h.service.createGroupTopic(group.id, "Topic");
    expect(topic.executionTarget).toBeUndefined();
    const accepted = await h.service.acceptGroupPrompt({
      conversationId: group.id,
      topicId: topic.id,
      requestId: "per-member",
      text: "go",
      target: { mode: "everyone" },
      humanIngress: HUMAN,
    });
    const turns = h.store.listMemberTurns(accepted.run.id);
    const byBot = new Map(turns.map((turn) => [turn.botId, turn.profileSnapshot?.execution.workspace]));
    expect(byBot.get(members[0]!)).toBe("backend");
    expect(byBot.get(members[1]!)).toBe("backend");
    expect(byBot.get(members[2]!)).toBe("alt");
  } finally {
    await cleanup();
  }
});

test("a shared Group still stamps the Topic workspace onto every member", async () => {
  const { h, backend, cleanup } = await splitHarness();
  try {
    const members = [backend[0]!, backend[1]!];
    const group = await h.bots.createGroup({ title: "Shared", botIds: members });
    expect(group.workspaceMode).toBeUndefined();
    const topic = await h.service.createGroupTopic(group.id, "Topic", { workspace: "alt", isolation: "shared-single-writer" });
    const accepted = await h.service.acceptGroupPrompt({
      conversationId: group.id,
      topicId: topic.id,
      requestId: "shared",
      text: "go",
      target: { mode: "everyone" },
      humanIngress: HUMAN,
    });
    // The Bot default (backend) is deliberately discarded.
    for (const turn of h.store.listMemberTurns(accepted.run.id)) {
      expect(turn.profileSnapshot?.execution.workspace).toBe("alt");
    }
  } finally {
    await cleanup();
  }
});

test("per-member members on distinct workspaces execute concurrently", async () => {
  const { h, backend, alt, cleanup } = await splitHarness();
  try {
    const members = [backend[0]!, alt[0]!];
    const group = await h.bots.createGroup({ title: "Split", botIds: members, workspaceMode: "per-member" });
    const topic = await h.service.createGroupTopic(group.id, "Topic", undefined, { maxConcurrentMemberTurns: 2 });
    // Unproven effect: only the distinct-directory rule can allow overlap.
    h.accept(group.id, topic.id, 2, false, "concurrent", undefined, members);
    const drain = h.dispatcher.kick();
    await until(() => h.runner.calls.length === 2);
    expect(h.runner.active).toBe(2);
    const workspaces = h.runner.calls.map((call) => h.state.sessions[call.sessionAlias]?.workspace);
    expect(new Set(workspaces)).toEqual(new Set(["backend", "alt"]));
    h.runner.finish(0);
    h.runner.finish(1);
    await drain;
  } finally {
    await cleanup();
  }
});

test("per-member members sharing one workspace stay serialized", async () => {
  const { h, backend, cleanup } = await splitHarness();
  try {
    const members = [backend[0]!, backend[1]!];
    const group = await h.bots.createGroup({ title: "Split", botIds: members, workspaceMode: "per-member" });
    const topic = await h.service.createGroupTopic(group.id, "Topic", undefined, { maxConcurrentMemberTurns: 2 });
    h.accept(group.id, topic.id, 2, false, "same-workspace", undefined, members);
    const drain = h.dispatcher.kick();
    await until(() => h.runner.calls.length === 1);
    expect(h.runner.active).toBe(1);
    h.runner.finish(0);
    await until(() => h.runner.calls.length === 2);
    expect(h.runner.active).toBe(1);
    h.runner.finish(1);
    await drain;
  } finally {
    await cleanup();
  }
});

test("Group Topic creation follows the Group's workspace mode", async () => {
  const { h, backend, cleanup } = await splitHarness();
  try {
    const members = [backend[0]!, backend[1]!];
    const perMember = await h.bots.createGroup({ title: "Split", botIds: members, workspaceMode: "per-member" });
    await expect(h.service.createGroupTopic(perMember.id, "Topic", { workspace: "backend", isolation: "shared" }))
      .rejects.toMatchObject({ code: "execution_target_unexpected" });

    const shared = await h.bots.createGroup({ title: "Shared", botIds: members });
    await expect(h.service.createGroupTopic(shared.id, "Topic"))
      .rejects.toMatchObject({ code: "execution_target_missing" });

    await expect(h.bots.createGroup({ title: "Bad", botIds: members, workspaceMode: "per-workspace" as never }))
      .rejects.toMatchObject({ code: "invalid_workspace_mode" });
  } finally {
    await cleanup();
  }
});

test("a leftover Topic target on a per-member Group is inert for scheduling", async () => {
  const { h, backend, cleanup } = await splitHarness();
  try {
    const members = [backend[0]!, backend[1]!];
    const perMember = await h.bots.createGroup({ title: "Split", botIds: members, workspaceMode: "per-member" });
    const topic = await h.service.createGroupTopic(perMember.id, "Topic");
    // No RPC can produce this row; a hand-edited or quarantined one can. The
    // Run was accepted with no worktree base, so honouring the isolation here
    // would fail every member turn on a prepare that was never provisioned.
    h.state.conversation_topics[topic.id]!.executionTarget = { workspace: "backend", isolation: "worktree-per-member" };
    expect(h.runtime.groupTopicIsolation(perMember.id, topic.id)).toBe("shared-single-writer");

    const shared = await h.bots.createGroup({ title: "Shared", botIds: members });
    const sharedTopic = await h.service.createGroupTopic(shared.id, "Topic", { workspace: "backend", isolation: "shared" });
    expect(h.runtime.groupTopicIsolation(shared.id, sharedTopic.id)).toBe("shared");
  } finally {
    await cleanup();
  }
});
