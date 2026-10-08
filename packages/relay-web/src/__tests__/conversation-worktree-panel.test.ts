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
