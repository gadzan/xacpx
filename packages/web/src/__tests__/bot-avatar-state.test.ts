import { describe, expect, it } from "vitest";
import type { ConversationRunDto, InteractionRequestDto } from "@ganglion/xacpx-relay-protocol";
import { avatarHasOpenInteraction, botAvatarState } from "../lib/bot-avatar-state";

const run: ConversationRunDto = {
  id: "run-1", conversationId: "conversation-1", topicId: "topic-1", requestMessageId: "message-1",
  requestId: "request-1", mode: "explicit", state: "running", profileRevision: 1, createdAt: "2026-10-14T00:00:00Z",
};
const request: InteractionRequestDto = {
  requestId: "interaction-1", kind: "elicitation", expiresAt: 10_000,
  conversation: { conversationId: run.conversationId, topicId: run.topicId, runId: run.id, botId: "bot-1", memberTurnId: "member-1" },
};
const scope = { instanceId: "instance-1", botId: "bot-1", run, memberTurnId: "member-1" };

describe("Bot avatar activity", () => {
  it("does not let stale output or an open question override a terminal task", () => {
    expect(botAvatarState({ runState: "failed", liveStatus: "streaming", waiting: true })).toBe("failed");
    expect(botAvatarState({ runState: "cancelled", memberState: "running", liveStatus: "streaming" })).toBe("cancelled");
  });

  it("keeps completed members distinct from a failed group run", () => {
    expect(botAvatarState({ runState: "failed", memberState: "completed" })).toBe("completed");
    expect(botAvatarState({ runState: "running", memberState: "dispatched", liveStatus: "streaming" })).toBe("queued");
  });

  it("only displays text output while the owning task is running", () => {
    expect(botAvatarState({ runState: "running", liveStatus: "working" })).toBe("working");
    expect(botAvatarState({ runState: "running", liveStatus: "streaming" })).toBe("streaming");
    expect(botAvatarState({ liveStatus: "streaming" })).toBe("idle");
  });

  it("leaves Router waiting at the run level rather than waiting every member", () => {
    expect(botAvatarState({ runState: "waiting-human", memberState: "running" })).toBe("working");
    expect(botAvatarState({ runState: "waiting-human" })).toBe("waiting");
    expect(botAvatarState({ runState: "running", memberState: "running", waiting: true })).toBe("waiting");
  });

  it("stops activity when the instance disconnects and retains removal priority", () => {
    expect(botAvatarState({ online: false, runState: "running", liveStatus: "streaming" })).toBe("offline");
    expect(botAvatarState({ retired: true, online: false, runState: "running" })).toBe("retired");
  });

  it("requires an open interaction for the exact instance, Bot and MemberTurn", () => {
    const interaction = { instanceId: "instance-1", outcome: null, request };
    expect(avatarHasOpenInteraction(interaction, scope)).toBe(true);
    expect(avatarHasOpenInteraction({ ...interaction, instanceId: "instance-2" }, scope)).toBe(false);
    expect(avatarHasOpenInteraction(interaction, { ...scope, botId: "bot-2" })).toBe(false);
    expect(avatarHasOpenInteraction(interaction, { ...scope, memberTurnId: "member-2" })).toBe(false);
    expect(avatarHasOpenInteraction({ ...interaction, outcome: "accepted" }, scope)).toBe(false);
  });

  it("rejects a different Topic and an interaction without product attribution", () => {
    const interaction = { instanceId: "instance-1", outcome: null, request };
    expect(avatarHasOpenInteraction(interaction, { ...scope, run: { ...run, topicId: "topic-2" } })).toBe(false);
    expect(avatarHasOpenInteraction({ ...interaction, request: { ...request, conversation: undefined } }, scope)).toBe(false);
    expect(avatarHasOpenInteraction(interaction, { ...scope, botId: undefined })).toBe(false);
  });
});
