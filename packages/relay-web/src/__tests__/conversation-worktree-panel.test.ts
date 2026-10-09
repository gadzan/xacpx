import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mount, flushPromises, type VueWrapper } from "@vue/test-utils";
import { MSG, type ConversationWorktreeStatusDto } from "@ganglion/xacpx-relay-protocol";
import { i18n } from "../i18n";
import Panel from "../components/ConversationWorktreePanel.vue";
const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock("../api/client", () => ({ api: { rpc } }));
let wrapper: VueWrapper | undefined;
const status = (revision = 1): ConversationWorktreeStatusDto => ({ runId: "r", revision, baseCommitSha: "a".repeat(40), disposition: "pending",
  resources: [{ id: "wa", botId: "a", kind: "member", state: "awaiting-integration", worktreePath: "/managed/a", branchRef: "refs/heads/member" }] });
const preview = () => ({ ...status(2), preview: { id: "p", createdAt: "now", members: [{ botId: "a", worktreeId: "wa", head: "a".repeat(40), tree: "b".repeat(40), files: ["file.txt"], diff: "+a change" }] } });
async function open(value = status()) {
  rpc.mockResolvedValueOnce({ run: { worktree: value } });
  wrapper = mount(Panel, { props: { instanceId: "i", runId: "r" }, global: { plugins: [i18n] } });
  await flushPromises(); return wrapper;
}
function button(part: string) { return wrapper!.findAll("button").find(b => b.text().includes(i18n.global.t(`group.worktree.${part}`)))!; }
beforeEach(() => { rpc.mockReset(); });
afterEach(() => { wrapper?.unmount(); wrapper = undefined; });

it("previews complete members and requires explicit consent before authorizing snapshots", async () => {
  await open(); rpc.mockResolvedValueOnce({ worktree: preview() }); await button("preview").trigger("click"); await flushPromises();
  expect(rpc).toHaveBeenLastCalledWith("i", MSG.conversationWorktree, { action: "preview", runId: "r", botIds: ["a"] });
  expect(wrapper!.text()).toContain("+a change"); expect(button("integrate").attributes("disabled")).toBeDefined();
  await wrapper!.find('input[type="checkbox"]').setValue(true);
  rpc.mockResolvedValueOnce({ worktree: preview() }); await button("integrate").trigger("click"); await flushPromises();
  expect(rpc.mock.lastCall?.[2]).toMatchObject({ action: "integrate", runId: "r", previewId: "p", snapshotUncommitted: true });
  expect(rpc.mock.lastCall?.[2].requestId).toEqual(expect.any(String));
});

it("displays persistent candidate/conflicts and explicitly continues the original Run", async () => {
  const value = { ...preview(), resources: [...status().resources, { id: "wi", botId: "integration", kind: "integration" as const, state: "ready" as const, worktreePath: "/managed/candidate", branchRef: "refs/heads/candidate" }],
    integration: { id: "integration", generation: 1, operationSource: "control" as const, requestId: "q", previewId: "p", state: "conflicted" as const, resourceId: "wi", orderedBotIds: ["a"], patches: ["c".repeat(40)], nextIndex: 0,
      candidateCommitSha: "a".repeat(40), conflictFiles: ["file.txt"], createdAt: "now", updatedAt: "now" } };
  await open(value); expect(wrapper!.text()).toContain("file.txt"); expect(wrapper!.text()).toContain("refs/heads/candidate");
  rpc.mockResolvedValueOnce({ worktree: value }); await button("continue").trigger("click"); await flushPromises();
  expect(rpc).toHaveBeenLastCalledWith("i", MSG.conversationWorktree, { action: "continue", runId: "r" });
});

it("does not replace newer status with an older poll response", async () => {
  await open(status(5)); rpc.mockResolvedValueOnce({ run: { worktree: { ...status(2), disposition: "abandoned" } } });
  await button("refresh").trigger("click"); await flushPromises();
  expect(wrapper!.find("summary").text()).toContain("pending");
});

it("ignores an old Run response after selection changes", async () => {
  let finish!: (v: unknown) => void; rpc.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
  wrapper = mount(Panel, { props: { instanceId: "i", runId: "r" }, global: { plugins: [i18n] } });
  rpc.mockResolvedValueOnce({ run: { worktree: { ...status(), runId: "new", disposition: "abandoned" } } });
  await wrapper.setProps({ runId: "new" }); await flushPromises(); finish({ run: { worktree: status(10) } }); await flushPromises();
  expect(wrapper.find("summary").text()).toContain("abandoned");
});

it("clears a stale error once a later poll succeeds", async () => {
  await open(status(2)); rpc.mockRejectedValueOnce(new Error("network down"));
  await button("refresh").trigger("click"); await flushPromises();
  // The failed poll leaves the error visible beside the last good status.
  expect(wrapper!.find("[role='alert']").exists()).toBe(true);
  expect(wrapper!.text()).toContain("network down");
  // Recovery: the next accepted response must drop the stale error, not stack a
  // stale failure on top of current data.
  rpc.mockResolvedValueOnce({ run: { worktree: status(3) } });
  await button("refresh").trigger("click"); await flushPromises();
  expect(wrapper!.find("[role='alert']").exists()).toBe(false);
  expect(wrapper!.text()).not.toContain("network down");
  expect(wrapper!.find("summary").text()).toContain("pending");
});

it("keeps the error when a poll fails after a stale error was cleared", async () => {
  await open(status(2));
  // Two consecutive failures must both surface; the fix only clears on success.
  rpc.mockRejectedValueOnce(new Error("first down")); await button("refresh").trigger("click"); await flushPromises();
  expect(wrapper!.text()).toContain("first down");
  rpc.mockRejectedValueOnce(new Error("second down")); await button("refresh").trigger("click"); await flushPromises();
  expect(wrapper!.text()).toContain("second down");
  expect(wrapper!.text()).not.toContain("first down");
});

it("clears the error only when the newer response is actually accepted", async () => {
  await open(status(5)); rpc.mockRejectedValueOnce(new Error("network down"));
  await button("refresh").trigger("click"); await flushPromises();
  expect(wrapper!.text()).toContain("network down");
  // A stale (lower-revision) response must not clear the error, because it is
  // not accepted as the current status either.
  rpc.mockResolvedValueOnce({ run: { worktree: { ...status(2), disposition: "abandoned" } } });
  await button("refresh").trigger("click"); await flushPromises();
  expect(wrapper!.find("summary").text()).toContain("pending");
  expect(wrapper!.text()).toContain("network down");
  // An accepted newer response clears it.
  rpc.mockResolvedValueOnce({ run: { worktree: status(6) } });
  await button("refresh").trigger("click"); await flushPromises();
  expect(wrapper!.find("[role='alert']").exists()).toBe(false);
});

it("keeps a failed operation visible and clears it when a later poll succeeds", async () => {
  await open(status(2));
  // operate() failure: the error must survive, and status must stay unchanged.
  rpc.mockRejectedValueOnce(new Error("integrate rejected"));
  await button("preview").trigger("click"); await flushPromises();
  expect(wrapper!.text()).toContain("integrate rejected");
  // A successful poll must clear it, since the panel is polling again.
  rpc.mockResolvedValueOnce({ run: { worktree: status(3) } });
  await button("refresh").trigger("click"); await flushPromises();
  expect(wrapper!.find("[role='alert']").exists()).toBe(false);
});

it("does not let an older in-flight poll resurrect a stale error when it fails", async () => {
  // Freeze the 5s poll so the only in-flight requests are the two below; with a
  // live interval the timer can consume the first mock and invert the order.
  vi.useFakeTimers();
  try {
    await open(status(3));
    let rejectOld!: (reason: unknown) => void;
    // Two overlapping polls: the older is still pending when the newer one
    // resolves. `epoch` is identical for both, so only a request sequence can
    // tell them apart.
    rpc.mockReturnValueOnce(new Promise((_resolve, reject) => { rejectOld = reject; }));
    rpc.mockResolvedValueOnce({ run: { worktree: status(4) } });
    await button("refresh").trigger("click");
    await button("refresh").trigger("click");
    await flushPromises();
    // The newer poll won and set the current status; no error is showing.
    expect(wrapper!.find("summary").text()).toContain("pending");
    expect(wrapper!.find("[role='alert']").exists()).toBe(false);
    // Now the older request fails. Its error must be discarded because a newer
    // request already established the current state.
    rejectOld(new Error("stale poll failure"));
    await flushPromises();
    expect(wrapper!.find("[role='alert']").exists()).toBe(false);
    expect(wrapper!.text()).not.toContain("stale poll failure");
    expect(wrapper!.find("summary").text()).toContain("pending");
  } finally { vi.useRealTimers(); }
});

it("still surfaces a failure when no newer request has started", async () => {
  await open(status(3));
  // The single in-flight request fails: there is no newer request to defer to,
  // so the error must appear.
  rpc.mockRejectedValueOnce(new Error("only poll failed"));
  await button("refresh").trigger("click"); await flushPromises();
  expect(wrapper!.find("[role='alert']").exists()).toBe(true);
  expect(wrapper!.text()).toContain("only poll failed");
});
