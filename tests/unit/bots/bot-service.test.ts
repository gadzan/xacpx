import { expect, test } from "bun:test";

import { BotError } from "../../../src/bots/bot-error";
import { BotService } from "../../../src/bots/bot-service";
import { createDirectBindingId } from "../../../src/domain/ids";
import { createEmptyState } from "../../../src/state/types";
import type { AppState } from "../../../src/state/types";
import type { StateStore } from "../../../src/state/state-store";

const NOW = "2026-09-15T10:00:00.000Z";

class MemoryStateStore implements Pick<StateStore, "save"> {
  public saved: AppState[] = [];
  async save(state: AppState): Promise<void> {
    this.saved.push(structuredClone(state));
  }
}

function createService(state = createEmptyState()) {
  const store = new MemoryStateStore();
  const service = new BotService(
    {
      agents: { codex: { driver: "codex" }, claude: { driver: "claude" } },
      workspaces: { backend: { cwd: "/tmp/backend" }, frontend: { cwd: "/tmp/frontend" } },
    },
    state,
    store,
    { now: () => new Date(NOW), createId: () => "bot_fixed" },
  );
  return { service, store, state };
}

test("createBot persists a profile with a stable id independent from its name", async () => {
  const { service, state } = createService();
  const bot = await service.createBot({
    name: "Reviewer",
    agent: "codex",
    workspace: "backend",
    role: "review",
  });
  expect(bot.id).toBe("bot_fixed");
  expect(bot.name).toBe("Reviewer");
  expect(bot.profileRevision).toBe(1);
  expect(state.bots.bot_fixed?.id).toBe("bot_fixed");
  await service.updateBot("bot_fixed", { name: "Senior Reviewer" });
  expect(service.getBot("bot_fixed").id).toBe("bot_fixed");
  expect(service.getBot("bot_fixed").name).toBe("Senior Reviewer");
  expect(service.getBot("bot_fixed").profileRevision).toBe(2);
});

test("createBot rejects an empty name and unknown agent or workspace", async () => {
  const { service } = createService();
  await expect(service.createBot({ name: "  ", agent: "codex", workspace: "backend" })).rejects.toMatchObject({
    code: "name_required",
  });
  await expect(service.createBot({ name: "R", agent: "nope", workspace: "backend" })).rejects.toBeInstanceOf(BotError);
  await expect(service.createBot({ name: "R", agent: "codex", workspace: "nope" })).rejects.toMatchObject({
    code: "workspace_not_registered",
  });
});

test("createBot rejects cwd instead of persisting a silent no-op", async () => {
  const { service, state } = createService();
  await expect(service.createBot({
    name: "Reviewer",
    agent: "codex",
    workspace: "backend",
    cwd: "/tmp/backend",
  } as never)).rejects.toMatchObject({ code: "cwd_unsupported" });
  expect(state.bots.bot_fixed).toBeUndefined();
});

test("updateBot rejects agent and workspace changes after a direct runtime exists", async () => {
  const { service, state } = createService();
  await service.createBot({ name: "Reviewer", agent: "codex", workspace: "backend" });
  state.bot_runtime_bindings.bind_direct = {
    id: "bind_direct",
    scope: "bot-direct",
    conversationId: "conversation_direct",
    topicId: "topic_default",
    botId: "bot_fixed",
    logicalSessionId: "11111111-1111-4111-8111-111111111111",
    sessionAlias: "brt_bind_direct",
    createdAt: NOW,
    updatedAt: NOW,
  };
  await expect(service.updateBot("bot_fixed", { agent: "codex" })).resolves.toMatchObject({ agent: "codex" });
  await expect(service.updateBot("bot_fixed", { agent: "claude" })).rejects.toMatchObject({
    code: "runtime_identity_locked",
  });
  await expect(service.updateBot("bot_fixed", { workspace: "frontend" })).rejects.toMatchObject({
    code: "runtime_identity_locked",
  });
  expect(service.getBot("bot_fixed").agent).toBe("codex");
  expect(service.getBot("bot_fixed").workspace).toBe("backend");
});

test("updateBot clears instructions so the next profile has no stale persona text", async () => {
  const { service } = createService();
  await service.createBot({
    name: "Reviewer",
    agent: "codex",
    workspace: "backend",
    instructions: "Focus on races.",
  });
  const updated = await service.updateBot("bot_fixed", { instructions: null });
  expect(updated.instructions).toBeUndefined();
});

test("deleteBot fails closed when a Group conversation still references the Bot", async () => {
  const state = createEmptyState();
  state.conversations.team = {
    id: "team",
    kind: "group",
    title: "Release",
    botIds: ["bot_fixed", "bot_other"],
    createdAt: NOW,
    updatedAt: NOW,
  };
  const { service } = createService(state);
  await service.createBot({ name: "Reviewer", agent: "codex", workspace: "backend" });
  await expect(service.deleteBot("bot_fixed")).rejects.toMatchObject({
    code: "bot_in_group",
    details: { conversationIds: ["team"] },
  });
  expect(service.getBot("bot_fixed").name).toBe("Reviewer");
});

test("updateBot can change agent and workspace before any runtime exists", async () => {
  const { service } = createService();
  await service.createBot({ name: "Reviewer", agent: "codex", workspace: "backend" });
  const updated = await service.updateBot("bot_fixed", { agent: "claude", workspace: "frontend" });
  expect(updated.agent).toBe("claude");
  expect(updated.workspace).toBe("frontend");
});

test("createTopic-only conversation does not lock identity but keeps delete fail-closed", async () => {
  const { service, state } = createService();
  await service.createBot({ name: "Reviewer", agent: "codex", workspace: "backend" });
  // A persisted Direct Conversation row with no binding and no owned session
  // (exactly what createDirectTopic persists before any execution).
  state.conversations.direct = {
    id: "direct",
    kind: "bot",
    title: "Reviewer",
    botIds: ["bot_fixed"],
    createdAt: NOW,
    updatedAt: NOW,
  };
  expect(service.hasRuntime("bot_fixed")).toBe(false);
  // agent/workspace stay editable: no actual runtime materialized.
  const updated = await service.updateBot("bot_fixed", { agent: "claude", workspace: "frontend" });
  expect(updated.agent).toBe("claude");
  expect(updated.workspace).toBe("frontend");
  // delete stays fail-closed via bot_in_use while the Conversation row exists.
  await expect(service.deleteBot("bot_fixed")).rejects.toMatchObject({
    code: "bot_in_use",
  });
  expect(service.getBot("bot_fixed").name).toBe("Reviewer");
});

test("deleteBot fails closed when a direct conversation still references the Bot", async () => {
  const { service, state } = createService();
  await service.createBot({ name: "Reviewer", agent: "codex", workspace: "backend" });
  state.conversations.direct = {
    id: "direct",
    kind: "bot",
    title: "Reviewer",
    botIds: ["bot_fixed"],
    createdAt: NOW,
    updatedAt: NOW,
  };
  await expect(service.deleteBot("bot_fixed")).rejects.toMatchObject({
    code: "bot_in_use",
  });
  expect(service.getBot("bot_fixed").name).toBe("Reviewer");
});

test("deleteBot fails closed when an owned session exists without a binding", async () => {
  const { service, state } = createService();
  await service.createBot({ name: "Reviewer", agent: "codex", workspace: "backend" });
  const bindingId = createDirectBindingId("bot_fixed");
  state.sessions[`brt_${bindingId}`] = {
    alias: `brt_${bindingId}`,
    agent: "codex",
    workspace: "backend",
    transport_session: `backend:brt_${bindingId}`,
    logical_session_id: "11111111-1111-4111-8111-111111111111",
    created_at: NOW,
    last_used_at: NOW,
    owner: { kind: "bot-direct", bindingId },
  };
  await expect(service.deleteBot("bot_fixed")).rejects.toMatchObject({
    code: "bot_in_use",
  });
});

test("deleteBot removes a Bot that has no conversations or runtime", async () => {
  const { service, state } = createService();
  await service.createBot({ name: "Reviewer", agent: "codex", workspace: "backend" });
  await service.deleteBot("bot_fixed");
  expect(state.bots.bot_fixed).toBeUndefined();
  expect(() => service.getBot("bot_fixed")).toThrow(BotError);
});

test("createBot uses saveNow before publishing live state", async () => {
  const state = createEmptyState();
  const store = {
    saved: [] as AppState[],
    durable: [] as AppState[],
    async save(next: AppState) {
      this.saved.push(structuredClone(next));
    },
    async saveNow(next: AppState) {
      this.durable.push(structuredClone(next));
    },
  };
  const service = new BotService(
    {
      agents: { codex: { driver: "codex" } },
      workspaces: { backend: { cwd: "/tmp/backend" } },
    },
    state,
    store,
    { now: () => new Date(NOW), createId: () => "bot_fixed" },
  );
  await service.createBot({ name: "Reviewer", agent: "codex", workspace: "backend" });
  expect(store.durable).toHaveLength(1);
  expect(store.saved).toHaveLength(0);
  expect(store.durable[0]?.bots.bot_fixed?.name).toBe("Reviewer");
  expect(state.bots.bot_fixed?.name).toBe("Reviewer");
});

test("deleteBot fails closed when ConversationStore still has durable work", async () => {
  const { service, state } = createService();
  await service.createBot({ name: "Reviewer", agent: "codex", workspace: "backend" });
  service.setConversationWork({ hasDurableBotWork: (botId) => botId === "bot_fixed" });
  await expect(service.deleteBot("bot_fixed")).rejects.toMatchObject({ code: "bot_in_use" });
  expect(state.bots.bot_fixed).toBeDefined();
});

test("createGroup validates membership, lead, and opaque identity", async () => {
  const state = createEmptyState();
  const store = new MemoryStateStore();
  const service = new BotService(
    {
      agents: { codex: { driver: "codex" } },
      workspaces: { backend: { cwd: "/tmp/backend" } },
    },
    state,
    store,
    { now: () => new Date(NOW) },
  );
  const a = await service.createBot({ name: "Reviewer", agent: "codex", workspace: "backend" });
  const b = await service.createBot({ name: "Tester", agent: "codex", workspace: "backend" });
  // min two members
  await expect(service.createGroup({ title: "Solo", botIds: [a.id] })).rejects.toMatchObject({
    code: "group_membership_min",
  });
  // duplicate members
  await expect(service.createGroup({ title: "Dup", botIds: [a.id, a.id] })).rejects.toMatchObject({
    code: "group_membership_duplicate",
  });
  // missing bot
  await expect(service.createGroup({ title: "Ghost", botIds: [a.id, "bot_missing"] })).rejects.toMatchObject({
    code: "bot_not_found",
  });
  // lead outside membership
  await expect(
    service.createGroup({ title: "Bad lead", botIds: [a.id, b.id], leadBotId: "bot_missing" }),
  ).rejects.toMatchObject({ code: "group_lead_not_member" });
  const group = await service.createGroup({
    title: "Release Team",
    description: "Ships it",
    botIds: [a.id, b.id],
    leadBotId: a.id,
  });
  expect(group.kind).toBe("group");
  expect(group.botIds).toEqual([a.id, b.id]);
  expect(group.leadBotId).toBe(a.id);
  expect(group.id.startsWith("conversation_")).toBe(true);
  expect(group.id).not.toContain("Release");
  expect(state.conversations[group.id]?.kind).toBe("group");
  // update: remove lead, shrink membership fails closed
  const noLead = await service.updateGroup(group.id, { leadBotId: null });
  expect(noLead.leadBotId).toBeUndefined();
  await expect(service.updateGroup(group.id, { botIds: [a.id] })).rejects.toMatchObject({
    code: "group_membership_min",
  });
  await service.deleteGroup(group.id);
  expect(state.conversations[group.id]).toBeUndefined();
});

test("deleteBot stays fail-closed while Group membership references the Bot", async () => {
  const state = createEmptyState();
  const store = new MemoryStateStore();
  let n = 0;
  const service = new BotService(
    {
      agents: { codex: { driver: "codex" } },
      workspaces: { backend: { cwd: "/tmp/backend" } },
    },
    state,
    store,
    { now: () => new Date(NOW), createId: () => `bot_${(n += 1)}` },
  );
  const a = await service.createBot({ name: "Reviewer", agent: "codex", workspace: "backend" });
  const b = await service.createBot({ name: "Tester", agent: "codex", workspace: "backend" });
  const group = await service.createGroup({ title: "Release Team", botIds: [a.id, b.id] });
  await expect(service.deleteBot(a.id)).rejects.toMatchObject({ code: "bot_in_group" });
  expect(state.bots[a.id]).toBeDefined();
  await service.deleteGroup(group.id);
  // Still fail-closed on direct runtime refs path (no runtime here, so delete succeeds).
  await service.deleteBot(a.id);
  expect(state.bots[a.id]).toBeUndefined();
});
test("group member classifiers prove exact triple ownership and fail closed on mismatch", async () => {
  const { classifyGroupMemberBindingOwnership, classifyGroupMemberSessionOwnership } =
    await import("../../../src/bots/bot-service");
  const { createScopedGroupMemberBindingId } = await import("../../../src/domain/ids");
  const binding = {
    id: createScopedGroupMemberBindingId("conv_g", "topic_t", "bot_a"),
    scope: "group-member" as const,
    conversationId: "conv_g",
    topicId: "topic_t",
    botId: "bot_a",
    logicalSessionId: "11111111-1111-4111-8111-111111111111",
    sessionAlias: "brt_group_x",
    createdAt: NOW,
    updatedAt: NOW,
  };
  expect(classifyGroupMemberBindingOwnership(binding, "bot_a", "conv_g", "topic_t")).toBe("owned");
  // Wrong Bot for the triple is a conflict, not silently foreign.
  expect(classifyGroupMemberBindingOwnership(binding, "bot_b", "conv_g", "topic_t")).toBe("conflict");
  // Wrong conversation is foreign (different scope entirely).
  expect(classifyGroupMemberBindingOwnership(binding, "bot_a", "conv_other", "topic_t")).toBe("foreign");
  // Direct scope never counts as member ownership.
  expect(classifyGroupMemberBindingOwnership({ ...binding, scope: "bot-direct" }, "bot_a", "conv_g", "topic_t")).toBe(
    "foreign",
  );
  const session = {
    owner: {
      kind: "group-member" as const,
      bindingId: binding.id,
      botId: "bot_a",
      conversationId: "conv_g",
      topicId: "topic_t",
    },
  };
  expect(classifyGroupMemberSessionOwnership(session, "bot_a", binding.id, "conv_g", "topic_t")).toBe("owned");
  expect(classifyGroupMemberSessionOwnership(session, "bot_b", binding.id, "conv_g", "topic_t")).toBe("conflict");
  expect(
    classifyGroupMemberSessionOwnership({ owner: { kind: "bot-direct", bindingId: binding.id } }, "bot_a", binding.id, "conv_g", "topic_t"),
  ).toBe("foreign");
});
