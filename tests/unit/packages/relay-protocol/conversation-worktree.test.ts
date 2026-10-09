import { expect, test } from "bun:test";
import { MSG, parseControlPayload, isConversationWorktreeStatus } from "../../../../packages/relay-protocol/src/index";

test("worktree operations have a strict independent wire contract and explicit snapshot consent", () => {
  for (const action of ["continue", "recover", "abandon", "cleanup"]) {
    expect(parseControlPayload(MSG.conversationWorktree, { action, runId: "r" })).toEqual({ action, runId: "r" });
  }
  const preview = { action: "preview", runId: "r", botIds: ["a", "b"] };
  const integrate = { action: "integrate", runId: "r", requestId: "q", previewId: "p", snapshotUncommitted: true };
  expect(parseControlPayload(MSG.conversationWorktree, preview)).toEqual(preview);
  expect(parseControlPayload(MSG.conversationWorktree, integrate)).toEqual(integrate);
  for (const value of [{ ...preview, botIds: [] }, { ...preview, botIds: ["a", "a"] }, { ...preview, path: "/arbitrary" },
    { ...integrate, snapshotUncommitted: false }, { ...integrate, snapshotUncommitted: undefined },
    { ...integrate, ownerToken: "fake" }, { action: "merge-main", runId: "r" }, { action: "cleanup" }]) {
    expect(parseControlPayload(MSG.conversationWorktree, value)).toBeNull();
  }
});

test("worktree responses retain diagnostics but cannot disclose ownership internals", () => {
  const resource = { id: "id", botId: "a", kind: "member", state: "awaiting-integration", worktreePath: "/managed/a", branchRef: "refs/heads/xacpx/a" };
  const status = { runId: "r", revision: 1, baseCommitSha: "a".repeat(40), disposition: "pending", resources: [resource] };
  expect(isConversationWorktreeStatus(status)).toBe(true);
  for (const extra of [{ state: "surprise" }, { ownerToken: "secret" }, { gitDir: "/internal" }, { snapshotSha: "bad-sha" }]) {
    expect(isConversationWorktreeStatus({ ...status, resources: [{ ...resource, ...extra }] })).toBe(false);
  }
  expect(isConversationWorktreeStatus({ ...status, revision: 0 })).toBe(false);
});
