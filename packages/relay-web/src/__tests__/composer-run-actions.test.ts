import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConversationMessageDto, ConversationRunDto } from "@ganglion/xacpx-relay-protocol";
import { api } from "../api/client";
import { mergeRecoveredDraft, sourceRunPrompt } from "../lib/composer-run-actions";
vi.mock("../api/client", () => ({ api: { rpc: vi.fn() } }));
const run: ConversationRunDto = { id: "run", conversationId: "conversation", topicId: "topic", requestMessageId: "source", requestId: "request", mode: "explicit", state: "running", profileRevision: 1, createdAt: "2026-10-22T00:00:00Z" };
const message: ConversationMessageDto = { id: "source", conversationId: "conversation", topicId: "topic", seq: 1, role: "human", content: "Original instruction", createdAt: run.createdAt };
beforeEach(() => vi.clearAllMocks());
describe("composer run actions", () => {
  it("merges recovered instructions with text typed while cancellation was pending", () => {
    expect(mergeRecoveredDraft("New instruction", "Original instruction")).toBe("New instruction\n\nOriginal instruction");
    expect(mergeRecoveredDraft("Original instruction", "Original instruction")).toBe("Original instruction");
  });
  it("looks up the exact request message and rejects another topic with the same id", async () => {
    vi.mocked(api.rpc).mockResolvedValueOnce({ messages: [message], hasMoreBefore: false });
    expect(await sourceRunPrompt("instance", run, [{ ...message, topicId: "other", content: "Wrong prompt" }])).toBe(message.content);
    expect(api.rpc).toHaveBeenCalledTimes(1);
  });
  it("loads older history when the source prompt has left the current page", async () => {
    vi.mocked(api.rpc)
      .mockResolvedValueOnce({ messages: [{ ...message, id: "later", seq: 51 }], oldestSeq: 51, hasMoreBefore: true })
      .mockResolvedValueOnce({ messages: [message], oldestSeq: 1, hasMoreBefore: false });
    expect(await sourceRunPrompt("instance", run, [])).toBe(message.content);
    expect(vi.mocked(api.rpc).mock.calls[1]?.[2]).toMatchObject({ beforeSeq: 51, conversationId: "conversation", topicId: "topic" });
  });
});
